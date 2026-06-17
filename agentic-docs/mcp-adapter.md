# MCP Adapter — Pitfalls and Patterns

Gotchas and correct patterns for the `/mcp` package (MCP server that bridges Claude CLI to the WS relay). Each section is self-contained.

| § | Symptom |
|---|---------|
| 1 | `tsc` fails with `TS2589: Type instantiation is excessively deep` on every `registerTool`/`tool` call |
| 2 | `callTool()` return type makes `.content` a TypeScript `unknown` |
| 3 | Test fails with `MCP error -32602: Invalid Base64 string` on image content |
| 4 | How to test the MCP adapter in-process without a real browser or relay |
| 5 | `registerTool` vs `tool` — which to use |
| 6 | Testing MCP tools that block until a delayed relay response arrives |
| 7 | SDK subpath imports crash the process at startup — postinstall patch required |
| 8 | Diagnosing MCP connection failures: `-32000` vs timeout vs working |
| 9 | Relay connection must be non-blocking — connect stdio first, relay in background |


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


## 6. Testing MCP tools that block until a delayed relay response arrives

**Context:** Some MCP tools (`handoff`) block until the relay synthesizes a response from a later unsolicited plugin event. The relay waits for the plugin to send a completion signal before it responds to the agent — so the relay response is intentionally delayed.

**Trap:** Using `mockRelayRespond()` (which sends a response synchronously within the same `socket.once('message')` handler) doesn't work here — you need the tool call to start, then the mock to respond after a short delay.

**Fix:** Pre-register the mock handler with a `setTimeout` so the response arrives asynchronously after the tool call begins:

```typescript
it('handoff tool blocks until relay sends complete result', async () => {
  const requestSeen = new Promise<Record<string, unknown>>((resolve) => {
    mockRelaySocket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      // Simulate relay: delay, then send the synthesized complete result
      setTimeout(() => {
        mockRelaySocket.send(JSON.stringify({
          id: message.id,
          type: 'result',
          data: { status: 'complete' },
        }));
      }, 20);
      resolve(message);   // resolve what the relay received (for assertion)
    });
  });

  // callTool blocks until the delayed response arrives
  const toolResult = await callTool(mcpClient, {
    name: 'handoff',
    arguments: { reason: 'Cloudflare challenge detected' },
  });

  const request = await requestSeen; // already resolved by the time callTool returns

  expect(request.type).toBe('handoff');
  expect(toolResult.isError).toBeFalsy();
  expect(toolResult.content[0].text).toContain('complete');
});
```

**Why `requestSeen` resolves before `toolResult`:** The `once('message')` handler fires and calls `resolve(message)` synchronously when the WS message arrives. `callTool` then waits for the `setTimeout` response to unblock it — so by the time `await callTool(...)` returns, `requestSeen` is already resolved.

**Compare with synchronous mock:** `mockRelayRespond()` (defined in the test file) responds immediately within the `once('message')` handler. Use `mockRelayRespond` for normal tools; use the `setTimeout` pattern only when you need to verify blocking behavior.


## 7. SDK subpath imports require a postinstall patch

**Trap:** The SDK's `package.json` wildcard export maps `"./*"` to `"require": "./dist/cjs/*"` (no `.js` in the target). Node.js does **not** apply CJS extension resolution (`.js` fallback) for wildcard-pattern export paths — the resolved path must be an exact file match. So `require("@modelcontextprotocol/sdk/server/stdio")` resolves to `./dist/cjs/server/stdio`, which doesn't exist (only `stdio.js` does), and the process crashes before any code runs.

**Fix:** `scripts/patch-mcp-sdk.js` (run via `postinstall`) rewrites the wildcard target to `"./dist/cjs/*.js"`. This makes `require("@modelcontextprotocol/sdk/server/stdio")` resolve to `./dist/cjs/server/stdio.js` — an exact match.

Import subpath exports without `.js` in source code — the patch makes that work at runtime:

```typescript
// CORRECT — no .js needed in source; patch-mcp-sdk.js ensures exact runtime resolution
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory';
```

If the MCP fails to start with "Cannot find module" after `npm install`, the patch didn't run. Re-run it manually: `node scripts/patch-mcp-sdk.js`.

**Why `tsc` and Vitest don't catch this:** TypeScript resolves types via the SDK's `typesVersions` field (not the `exports` field), so `tsc` compiles successfully regardless. Vitest uses Vite's bundler-style module resolver, which applies extension resolution even for package exports wildcards — so tests pass too. The bug only surfaces when Node.js loads the compiled CJS dist directly, which is exactly what Claude Code does when spawning the MCP process.


## 8. Diagnosing MCP connection failures

When `/mcp` fails, the error message tells you which layer broke:

| Error | Meaning | Where to look |
|---|---|---|
| `Failed to reconnect … -32000` | Process crashed before the MCP handshake (require-time crash) | `/tmp/agentic-driver-mcp.log` doesn't exist; check module resolution |
| `connection timed out after 30000ms` | Process started but handshake didn't complete in 30 s | Log exists; check what step it's stuck on |
| `Reconnected to agentic-driver` | Success | — |

**Check the log first:**

```
cat /tmp/agentic-driver-mcp.log
```

The log is written by `index.ts` at each startup step. Mapping log output to root causes:

| Last log line | Root cause |
|---|---|
| *(file doesn't exist)* | `require()` crashed before any code ran — module resolution failure (see § 7) |
| `Connecting to relay...` (no further lines, timeout) | Relay connection is blocking stdio startup — see § 9 |
| `MCP server ready` | MCP is running; connection failure is on Claude Code's side |

**After any code change, always delete the old log before reconnecting** so you're reading fresh output:

```bash
rm -f /tmp/agentic-driver-mcp.log
# then run /mcp
cat /tmp/agentic-driver-mcp.log
```


## 9. Relay connection must be non-blocking — connect stdio first

**Trap:** If `index.ts` awaits `relayClient.connect()` before calling `server.connect(transport)`, Claude Code times out. The MCP handshake (initialize request/response on stdio) can't happen until the server is connected to the transport. The relay can take many seconds to be available — `ts-node-dev` compiles on startup, the user may not have run `npm run dev` yet, or the relay may be restarting. Claude Code's timeout is 30 seconds.

```
// WRONG — relay blocks stdio; Claude Code times out waiting for MCP handshake
await relayClient.connect();          // can take 30–60 s
await server.connect(transport);      // too late; Claude Code gave up
```

**Fix:** Connect to stdio first, relay in background.

```typescript
// CORRECT — stdio handshake completes immediately; relay connects whenever it's ready
const relayClient = new RelayClient(RELAY_URL);
const server = createMcpServer(relayClient);
const transport = new StdioServerTransport();

await server.connect(transport);      // handshake with Claude Code — returns in milliseconds

relayClient.connect().then(() => {
  log('Relay connected');
}).catch((error: unknown) => {
  log(`Relay connection failed: ${error instanceof Error ? error.message : String(error)}`);
  // Don't exit — tools return "Not connected to relay" until relay is up
});
```

**Consequence:** Tools called before the relay connects return `Error: Not connected to relay` from `RelayClient.send()`. This surfaces as an MCP tool error in the agent — acceptable, since the agent can retry after the relay is up.

**Rule:** `server.connect(transport)` must always come before any async I/O that could take more than a second. The relay connection is the only such operation in this codebase.
