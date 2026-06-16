import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
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

export function createMcpServer(relayClient: RelayClient): McpServer {
  const server = new McpServer({
    name: 'agentic-driver',
    version: '0.1.0',
  });

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

  return server;
}
