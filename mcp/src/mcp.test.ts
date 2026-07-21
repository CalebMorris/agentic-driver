import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { RelayClient } from './relay-client';
import type { Logger } from 'pino';
import { connectMcpClient, createTestLogger, mockRelayRespond, startMockRelay } from './test-helpers';

// callTool returns a complex union type; narrow to the common structured result for assertions.
type McpToolResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    resource?: { uri?: string; mimeType?: string; blob?: string; text?: string };
  }>;
  isError?: boolean;
};

function callTool(client: Client, params: Parameters<Client['callTool']>[0]): Promise<McpToolResult> {
  return client.callTool(params) as Promise<McpToolResult>;
}

const TEST_PORT = 9997;

describe('MCP Adapter', () => {
  let mockRelayWss: WebSocketServer;
  let mockRelaySocket: WebSocket;
  let relayClient: RelayClient;
  let mcpClient: Client;

  beforeAll(async () => {
    ({ wss: mockRelayWss, relayClient, relaySocket: mockRelaySocket } = await startMockRelay(TEST_PORT));
    mcpClient = await connectMcpClient(relayClient);
  });

  afterAll(async () => {
    await mcpClient.close();
    relayClient.close();
    await new Promise<void>((resolve) => mockRelayWss.close(() => resolve()));
  });

  // ── navigate ────────────────────────────────────────────────────────────────

  it('navigate tool sends correct WS request and returns result', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { url: 'https://example.com', status: 'complete' },
    });

    const toolResult = await callTool(mcpClient, {
      name: 'navigate',
      arguments: { url: 'https://example.com' },
    });

    const request = await requestSeen;

    expect(request.type).toBe('navigate');
    expect(request.url).toBe('https://example.com');
    expect(typeof request.id).toBe('string');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].type).toBe('text');
    expect(toolResult.content[0].text).toContain('complete');
  });

  // ── click ───────────────────────────────────────────────────────────────────

  it('click tool sends correct WS request and returns result', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { status: 'ok' },
    });

    const toolResult = await callTool(mcpClient, {
      name: 'click',
      arguments: { selector: '#submit-button' },
    });

    const request = await requestSeen;

    expect(request.type).toBe('click');
    expect(request.selector).toBe('#submit-button');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('ok');
  });

  // ── read_html ────────────────────────────────────────────────────────────────

  it('read_html tool sends request without selector when omitted', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { html: '<html><body>hello</body></html>' },
    });

    const toolResult = await callTool(mcpClient, { name: 'read_html', arguments: {} });

    const request = await requestSeen;

    expect(request.type).toBe('read_html');
    expect(request.selector).toBeUndefined();

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('hello');
  });

  it('read_html tool forwards optional selector', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { html: '<div id="main"><p>Content</p></div>' },
    });

    const toolResult = await callTool(mcpClient, {
      name: 'read_html',
      arguments: { selector: '#main' },
    });

    const request = await requestSeen;

    expect(request.type).toBe('read_html');
    expect(request.selector).toBe('#main');

    expect(toolResult.isError).toBeFalsy();
  });

  // ── screenshot ───────────────────────────────────────────────────────────────

  it('screenshot tool returns an image content block', async () => {
    // Must be valid base64 — the MCP SDK validates image data before relaying to the client.
    const fakeBase64 = Buffer.from('fake png data').toString('base64');

    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { image: fakeBase64 },
    });

    const toolResult = await callTool(mcpClient, { name: 'screenshot', arguments: {} });

    const request = await requestSeen;

    expect(request.type).toBe('screenshot');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].type).toBe('image');
    expect(toolResult.content[0].data).toBe(fakeBase64);
    expect(toolResult.content[0].mimeType).toBe('image/png');
  });

  // ── bundle ───────────────────────────────────────────────────────────────────

  it('bundle tool sends request and returns a zip resource with metadata', async () => {
    // Valid base64 — the MCP SDK validates blob data before relaying to the client.
    const fakeZip = Buffer.from('PK\x03\x04 fake zip bytes').toString('base64');

    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { zip: fakeZip, url: 'https://example.com/page', fileCount: 3, byteSize: 1234 },
    });

    const toolResult = await callTool(mcpClient, { name: 'bundle', arguments: {} });

    const request = await requestSeen;

    expect(request.type).toBe('bundle');

    expect(toolResult.isError).toBeFalsy();

    const textBlock = toolResult.content.find((block) => block.type === 'text');
    expect(textBlock?.text).toContain('example.com');
    expect(textBlock?.text).toContain('3');

    const resourceBlock = toolResult.content.find((block) => block.type === 'resource');
    expect(resourceBlock).toBeDefined();
    expect(resourceBlock?.resource?.mimeType).toBe('application/zip');
    expect(resourceBlock?.resource?.blob).toBe(fakeZip);
  });

  // ── view_current_site ────────────────────────────────────────────────────────

  it('view_current_site tool sends correct WS request and returns result', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { id: 42, url: 'https://example.com', title: 'Example', status: 'complete', active: true, faviconUrl: null },
    });

    const toolResult = await callTool(mcpClient, { name: 'view_current_site', arguments: {} });

    const request = await requestSeen;

    expect(request.type).toBe('view_current_site');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('example.com');
  });

  // ── handoff ───────────────────────────────────────────────────────────────────

  it('handoff tool sends correct WS request and blocks until relay sends complete result', async () => {
    // Simulate relay behavior: delay, then send synthesized complete result (skipping waiting_for_human)
    const requestSeen = mockRelayRespond(mockRelaySocket, { type: 'result', data: { status: 'complete' } }, 20);

    const toolResult = await callTool(mcpClient, {
      name: 'handoff',
      arguments: { reason: 'Cloudflare challenge detected' },
    });

    const request = await requestSeen;

    expect(request.type).toBe('handoff');
    expect(request.reason).toBe('Cloudflare challenge detected');
    expect(typeof request.id).toBe('string');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('complete');
  });

  // ── check_status ──────────────────────────────────────────────────────────────

  it('check_status tool sends status request to relay and returns status data', async () => {
    const requestSeen = mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { pluginConnected: true, drivingEnabled: false },
    });

    const toolResult = await callTool(mcpClient, { name: 'check_status', arguments: {} });
    const request = await requestSeen;

    expect(request.type).toBe('status');
    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('"relayConnected":true');
    expect(toolResult.content[0].text).toContain('"pluginConnected":true');
    expect(toolResult.content[0].text).toContain('"drivingEnabled":false');
  });

  // ── error handling ────────────────────────────────────────────────────────────

  it('relay error response is returned as an MCP error result', async () => {
    mockRelayRespond(mockRelaySocket, {
      type: 'error',
      code: 'ELEMENT_NOT_FOUND',
      message: "No element matches selector '#missing'",
    });

    const toolResult = await callTool(mcpClient, {
      name: 'click',
      arguments: { selector: '#missing' },
    });

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain('ELEMENT_NOT_FOUND');
  });
});

describe('MCP Adapter — check_status when relay is not connected', () => {
  let disconnectedMcpClient: Client;

  beforeEach(async () => {
    const disconnectedRelayClient = new RelayClient('ws://localhost:1'); // nothing listening
    disconnectedMcpClient = await connectMcpClient(disconnectedRelayClient);
  });

  afterEach(async () => {
    await disconnectedMcpClient.close();
  });

  it('check_status returns relayConnected false when relay is not connected', async () => {
    const toolResult = await callTool(disconnectedMcpClient, { name: 'check_status', arguments: {} });

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('"relayConnected":false');
    expect(toolResult.content[0].text).toContain('"pluginConnected":false');
    expect(toolResult.content[0].text).toContain('"drivingEnabled":false');
  });
});

const TIMEOUT_TEST_PORT = 9992;

describe('MCP Adapter — request timeout', () => {
  let mockRelayWss: WebSocketServer;
  let mockRelaySocket: WebSocket;
  let relayClient: RelayClient;
  let mcpClient: Client;

  beforeAll(async () => {
    // requestTimeoutMs = 100ms so timeout tests are fast.
    ({ wss: mockRelayWss, relayClient, relaySocket: mockRelaySocket } = await startMockRelay(
      TIMEOUT_TEST_PORT,
      { requestTimeoutMs: 100 }
    ));
    mcpClient = await connectMcpClient(relayClient);
  });

  afterAll(async () => {
    await mcpClient.close();
    relayClient.close();
    await new Promise<void>((resolve) => mockRelayWss.close(() => resolve()));
  });

  it('tool call returns RELAY_TIMEOUT error when the relay never responds', async () => {
    // The mock relay receives the message but never replies.
    const requestSeen = new Promise<Record<string, unknown>>((resolve) => {
      mockRelaySocket.once('message', (data) => {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    const toolResult = await callTool(mcpClient, {
      name: 'click',
      arguments: { selector: '#btn' },
    });
    const request = await requestSeen;

    expect(request.type).toBe('click');
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain('RELAY_TIMEOUT');
  });

  it('agent-supplied timeoutMs extends the timeout for a single call', async () => {
    // Respond after the 100ms default timeout but within the agent's override.
    const requestSeen = mockRelayRespond(mockRelaySocket, { type: 'result', data: { status: 'ok' } }, 250);

    const toolResult = await callTool(mcpClient, {
      name: 'click',
      arguments: { selector: '#slow-btn', timeoutMs: 1_000 },
    });
    const request = await requestSeen;

    // The timeout override is transport-level and must not leak into the relay payload.
    expect(request.timeoutMs).toBeUndefined();
    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('ok');
  });

  it('agent-supplied timeoutMs can shorten the timeout for a single call', async () => {
    // Relay never responds; a sub-default override should fail fast.
    mockRelaySocket.once('message', () => {});

    const startedAt = Date.now();
    const toolResult = await callTool(mcpClient, {
      name: 'read_html',
      arguments: { timeoutMs: 30 },
    });

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain('RELAY_TIMEOUT');
  });

  it('handoff is not subject to the request timeout', async () => {
    // Respond well after the 100ms request timeout — handoff must still succeed
    // because humans take arbitrarily long to complete a handoff.
    mockRelayRespond(mockRelaySocket, { type: 'result', data: { status: 'complete' } }, 250);

    const toolResult = await callTool(mcpClient, {
      name: 'handoff',
      arguments: { reason: 'Login wall' },
    });

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('complete');
  });
});

const LOGGING_TEST_PORT = 9993;

const PINO_INFO = 30;
const PINO_WARN = 40;
const PINO_ERROR = 50;

describe('MCP Adapter — structured logging', () => {
  let mockRelayWss: WebSocketServer;
  let mockRelaySocket: WebSocket;
  let relayClient: RelayClient;
  let mcpClient: Client;

  beforeAll(async () => {
    ({ wss: mockRelayWss, relayClient, relaySocket: mockRelaySocket } = await startMockRelay(LOGGING_TEST_PORT));
  });

  afterAll(async () => {
    await mcpClient?.close();
    relayClient.close();
    await new Promise<void>((resolve) => mockRelayWss.close(() => resolve()));
  });

  it('logs mcp_tool_call with tool name and args on navigate', async () => {
    const { logger, lines } = createTestLogger();
    mcpClient = await connectMcpClient(relayClient, logger);

    mockRelayRespond(mockRelaySocket, { type: 'result', data: { status: 'complete' } });
    await callTool(mcpClient, { name: 'navigate', arguments: { url: 'https://example.com' } });

    const toolCallLog = lines.find((line) => line.msg === 'mcp_tool_call');
    expect(toolCallLog).toBeDefined();
    expect(toolCallLog?.level).toBe(PINO_INFO);
    expect(toolCallLog?.tool).toBe('navigate');
    expect(toolCallLog?.url).toBe('https://example.com');
  });

  it('logs mcp_tool_success with durationMs on successful tool result', async () => {
    const { logger, lines } = createTestLogger();
    mcpClient = await connectMcpClient(relayClient, logger);

    mockRelayRespond(mockRelaySocket, { type: 'result', data: { status: 'ok' } });
    await callTool(mcpClient, { name: 'click', arguments: { selector: '#btn' } });

    const successLog = lines.find((line) => line.msg === 'mcp_tool_success');
    expect(successLog).toBeDefined();
    expect(successLog?.level).toBe(PINO_INFO);
    expect(successLog?.tool).toBe('click');
    expect(typeof successLog?.durationMs).toBe('number');
  });

  it('logs bundle_uri_fallback warning when the bundled page URL is not parseable', async () => {
    const { logger, lines } = createTestLogger();
    mcpClient = await connectMcpClient(relayClient, logger);

    const fakeZip = Buffer.from('PK\x03\x04 fake zip bytes').toString('base64');
    mockRelayRespond(mockRelaySocket, {
      type: 'result',
      data: { zip: fakeZip, url: 'not a valid url', fileCount: 1, byteSize: 10 },
    });

    const toolResult = await callTool(mcpClient, { name: 'bundle', arguments: {} });

    expect(toolResult.isError).toBeFalsy();
    const resourceBlock = toolResult.content.find((block) => block.type === 'resource');
    expect(resourceBlock?.resource?.uri).toBe('bundle://site.zip');

    const fallbackLog = lines.find((line) => line.msg === 'bundle_uri_fallback');
    expect(fallbackLog).toBeDefined();
    expect(fallbackLog?.level).toBe(PINO_WARN);
    expect(fallbackLog?.pageUrl).toBe('not a valid url');
  });

  it('logs mcp_tool_error with durationMs when relay returns an error', async () => {
    const { logger, lines } = createTestLogger();
    mcpClient = await connectMcpClient(relayClient, logger);

    mockRelayRespond(mockRelaySocket, { type: 'error', code: 'ELEMENT_NOT_FOUND', message: 'No element' });
    await callTool(mcpClient, { name: 'click', arguments: { selector: '#missing' } });

    const errorLog = lines.find((line) => line.msg === 'mcp_tool_error');
    expect(errorLog).toBeDefined();
    expect(errorLog?.level).toBe(PINO_ERROR);
    expect(errorLog?.tool).toBe('click');
    expect(typeof errorLog?.durationMs).toBe('number');
  });
});
