# MCP Adapter — Pitfalls and Patterns

Gotchas and correct patterns for the `/mcp` package (MCP server that bridges Claude CLI to the WS relay). Each section is self-contained.

| § | Symptom |
|---|---------|
| 1 | `tsc` fails with `TS2589: Type instantiation is excessively deep` on every `registerTool`/`tool` call |
| 2 | `callTool()` return type makes `.content` a TypeScript `unknown` |
| 3 | Test fails with `MCP error -32602: Invalid Base64 string` on image content |
| 4 | How to test the MCP adapter in-process without a real browser or relay |
| 5 | Import paths for the MCP SDK in CommonJS TypeScript |

---

## 1. `TS2589` deep instantiation — use zod v4, not v3

**Trap:** MCP SDK 1.29+'s type layer defines `AnySchema = z3.ZodTypeAny | z4.$ZodType`. When only zod v3 is installed, TypeScript has to resolve this union without a real `z4.$ZodType` and hits its recursion limit, producing:

```
error TS2589: Type instantiation is excessively deep and possibly infinite.
```

This happens on every `registerTool()` or `tool()` call, regardless of schema complexity.

**Fix:** Install zod v4 in the MCP adapter's `package.json`.

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^4.0.0"
  }
}
```

Import zod the same way (`import { z } from 'zod'`) — no code changes needed.

---

## 2. Prefer `registerTool` over `tool` for tool registration

**Trap:** `McpServer.tool()` has 7 overloads. TypeScript resolves overloads sequentially and the complex generic union in each overload (`paramsSchemaOrAnnotations: Args | ToolAnnotations`) can still hit instantiation limits in some TypeScript versions, even with zod v4.

**Fix:** Use `registerTool()` — it has a single, unambiguous signature with a config object.

```typescript
// FRAGILE — 7 overloads, TypeScript may struggle
server.tool('navigate', 'Description', { url: z.string() }, async ({ url }) => ...);

// CORRECT — single overload, clean generic resolution
server.registerTool(
  'navigate',
  {
    description: 'Navigate the pinned tab to a URL and wait for load.',
    inputSchema: { url: z.string().describe('URL to navigate to') },
  },
  async ({ url }) => ...
);
```

`registerTool` with no `inputSchema` (zero-arg tools like `screenshot`):
```typescript
server.registerTool(
  'screenshot',
  { description: 'Capture a screenshot of the pinned tab.' },
  async () => ...
);
```

---

## 3. `callTool()` return type makes `.content` a TypeScript `unknown`

**Trap:** `Client.callTool()` returns a complex union:

```typescript
Promise<{
  [x: string]: unknown;   // ← index signature
  content: Array<...>;
  isError?: boolean;
} | {
  [x: string]: unknown;
  toolResult: unknown;
}>
```

The index signature `[x: string]: unknown` on both branches means accessing `.content` on the union resolves to `unknown`, not `Array<...>`. TypeScript reports:

```
error TS18046: 'toolResult.content' is of type 'unknown'
```

**Fix:** Add a typed wrapper function in the test file that casts the result.

```typescript
type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
};

function callTool(client: Client, params: Parameters<Client['callTool']>[0]): Promise<McpToolResult> {
  return client.callTool(params) as Promise<McpToolResult>;
}

// In tests — use the wrapper, not client.callTool directly
const result = await callTool(mcpClient, { name: 'navigate', arguments: { url: '...' } });
expect(result.content[0].text).toContain('...');  // no TS error
```

---

## 4. Image content requires valid base64

**Trap:** The MCP SDK validates `data` in image content blocks before sending to the client. A fake string that looks like base64 but has wrong padding or invalid characters throws:

```
MCP error -32602: Invalid tools/call result: [{ "code": "custom", "path": ["data"], "message": "Invalid Base64 string" }]
```

This bites test mocks that use strings like `'iVBORfakedata=='`.

**Fix:** Use `Buffer.from(...)` to generate valid base64 in test mocks.

```typescript
// BROKEN — not valid base64
const fakeImage = 'iVBORfakedata==';

// CORRECT — valid base64 (content can be arbitrary bytes)
const fakeImage = Buffer.from('fake png data').toString('base64');

mockRelaySocket.send(JSON.stringify({
  id: message.id,
  type: 'result',
  data: { image: fakeImage },
}));
```

The assertion `expect(result.content[0].data).toBe(fakeImage)` still works — the SDK passes the data through unchanged.

---

## 5. Testing the MCP adapter in-process

**Pattern:** Use `InMemoryTransport.createLinkedPair()` to wire a real `McpServer` to a test `Client` in the same process, and a minimal `WebSocketServer` as a mock relay.

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory';

// 1. Start a mock relay (acts as ws://localhost:PORT endpoint for RelayClient)
const mockRelayWss = new WebSocketServer({ port: TEST_PORT });
await new Promise<void>((resolve) => {
  if (mockRelayWss.address()) resolve();
  else mockRelayWss.once('listening', resolve);
});

let mockRelaySocket: WebSocket;
const socketConnected = new Promise<WebSocket>((resolve) => {
  mockRelayWss.once('connection', resolve);
});

// 2. Connect RelayClient and capture the server-side socket
const relayClient = new RelayClient(`ws://localhost:${TEST_PORT}`);
await relayClient.connect();
mockRelaySocket = await socketConnected;

// 3. Create MCP server + in-memory transport pair
const mcpServer = createMcpServer(relayClient);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcpServer.connect(serverTransport);

const mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
await mcpClient.connect(clientTransport);
```

**One-shot mock relay responder** — pre-register a handler, then await the tool call:

```typescript
function mockRelayRespond(response: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    mockRelaySocket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      mockRelaySocket.send(JSON.stringify({ id: message.id, ...response }));
      resolve(message);
    });
  });
}

// In each test:
const requestSeen = mockRelayRespond({ type: 'result', data: { status: 'ok' } });
const result = await callTool(mcpClient, { name: 'click', arguments: { selector: '#btn' } });
const request = await requestSeen;  // already resolved by the time callTool returns

expect(request.type).toBe('click');      // verify what the adapter sent to the relay
expect(result.content[0].text).toContain('ok');  // verify what the client received
```

**Why this order works:** `mockRelayRespond` pre-registers a `socket.once('message')` handler without blocking. `callTool` then fires the WS message, which synchronously triggers the handler (within the same event loop turn), sends the response, and only then the `callTool` promise resolves. By the time `await callTool(...)` returns, `requestSeen` is already resolved.

---

## 6. CommonJS import paths for the MCP SDK

With `"module": "CommonJS"` in `tsconfig.json`, import the SDK's subpath exports **without** `.js` extensions.

```typescript
// CORRECT (CommonJS)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory';
```

The `.js` extension form (`'.../server/mcp.js'`) is for ESM. The SDK ships CJS builds at `dist/cjs/` which are resolved automatically by Node's CommonJS resolver.
