import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { type Logger, noopLogger } from './logger';
import { RelayClient } from './relay-client';

type RelayResponse = Record<string, unknown>;

function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
  };
}

function errorResult(code: unknown, message: unknown) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: `Error [${code}]: ${message}` }],
  };
}

function handleRelayResponse(response: RelayResponse) {
  if (response.type === 'error') {
    return errorResult(response.code, response.message);
  }
  return textResult(response.data);
}

// Patch registerTool before any tools are registered so logging is injected
// into every handler automatically — no per-tool boilerplate required.
// registerTool has complex generics; we cast to avoid fighting them at the
// interception boundary, which is safe because the SDK validates args at runtime.
function patchRegisterToolWithLogging(server: McpServer, logger: Logger): void {
  type AnyHandler = (args: unknown) => Promise<{ isError?: boolean }>;
  type AnyRegisterTool = (name: string, config: unknown, handler: AnyHandler) => void;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;
  const orig = s.registerTool.bind(server) as AnyRegisterTool;

  s.registerTool = (name: string, config: unknown, handler: AnyHandler) => {
    orig(name, config, async (args: unknown) => {
      const argsRecord = args != null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
      logger.info({ tool: name, ...argsRecord }, 'mcp_tool_call');
      const startedAt = Date.now();
      const result = await handler(args);
      const durationMs = Date.now() - startedAt;
      if (result?.isError) {
        logger.error({ tool: name, durationMs }, 'mcp_tool_error');
      } else {
        logger.info({ tool: name, durationMs }, 'mcp_tool_success');
      }
      return result;
    });
  };
}

export function createMcpServer(relayClient: RelayClient, logger: Logger = noopLogger): McpServer {
  const server = new McpServer({
    name: 'agentic-driver',
    version: '0.1.0',
  });

  patchRegisterToolWithLogging(server, logger);

  server.registerTool(
    'check_status',
    {
      description: 'Check whether the agentic driver is ready to use. Returns whether the MCP adapter is connected to the relay server, whether the browser plugin is connected to the relay, and whether driving has been enabled in the plugin UI.',
    },
    async () => {
      if (!relayClient.isConnected()) {
        return textResult({ relayConnected: false, pluginConnected: false, drivingEnabled: false });
      }
      const response = await relayClient.send({ type: 'status' });
      if (response.type === 'error') {
        return errorResult(response.code, response.message);
      }
      return textResult({ relayConnected: true, ...(response.data as object) });
    }
  );

  server.registerTool(
    'navigate',
    {
      description: 'Navigate the pinned browser tab to a URL and wait for it to finish loading.',
      inputSchema: { url: z.string().describe('URL to navigate to') },
    },
    async ({ url }) => handleRelayResponse(await relayClient.send({ type: 'navigate', url }))
  );

  server.registerTool(
    'click',
    {
      description: 'Click an element in the pinned browser tab identified by a CSS selector.',
      inputSchema: { selector: z.string().describe('CSS selector of the element to click') },
    },
    async ({ selector }) => handleRelayResponse(await relayClient.send({ type: 'click', selector }))
  );

  server.registerTool(
    'read_html',
    {
      description: 'Read the HTML of the pinned browser tab, optionally scoped to a CSS selector.',
      inputSchema: {
        selector: z.string().optional().describe(
          'CSS selector to scope the returned HTML; returns full page HTML if omitted'
        ),
      },
    },
    async ({ selector }) => {
      const payload: Record<string, unknown> = { type: 'read_html' };
      if (selector !== undefined) payload.selector = selector;
      return handleRelayResponse(await relayClient.send(payload));
    }
  );

  server.registerTool(
    'screenshot',
    {
      description: 'Capture a screenshot of the pinned browser tab and return it as a base64-encoded PNG.',
    },
    async () => {
      const response = await relayClient.send({ type: 'screenshot' });
      if (response.type === 'error') {
        return errorResult(response.code, response.message);
      }
      const data = response.data as { image: string };
      return {
        content: [{ type: 'image' as const, data: data.image, mimeType: 'image/png' }],
      };
    }
  );

  server.registerTool(
    'view_current_site',
    {
      description: 'Get information about the current page in the pinned browser tab (URL, title, status).',
    },
    async () => handleRelayResponse(await relayClient.send({ type: 'view_current_site' }))
  );

  server.registerTool(
    'handoff',
    {
      description: 'Pause agent control and hand off to a human. Blocks until the human signals they are done. Use when encountering Cloudflare challenges, login walls, or other situations requiring human intervention.',
      inputSchema: { reason: z.string().describe('Reason for the handoff, shown to the human in the plugin UI') },
    },
    async ({ reason }) => handleRelayResponse(await relayClient.send({ type: 'handoff', reason }))
  );

  return server;
}
