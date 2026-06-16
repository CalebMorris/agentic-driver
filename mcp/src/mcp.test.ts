import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory';
import { createMcpServer } from './server';
import { RelayClient } from './relay-client';

// callTool returns a complex union type; narrow to the common structured result for assertions.
type McpToolResult = {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
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
    mockRelayWss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => {
      if (mockRelayWss.address()) resolve();
      else mockRelayWss.once('listening', resolve);
    });

    const socketConnected = new Promise<WebSocket>((resolve) => {
      mockRelayWss.once('connection', resolve);
    });

    relayClient = new RelayClient(`ws://localhost:${TEST_PORT}`);
    await relayClient.connect();
    mockRelaySocket = await socketConnected;

    const mcpServer = createMcpServer(relayClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
    await mcpClient.connect(clientTransport);
  });

  afterAll(async () => {
    await mcpClient.close();
    relayClient.close();
    await new Promise<void>((resolve) => mockRelayWss.close(() => resolve()));
  });

  // Helper: pre-register a one-shot mock relay response for the next incoming message.
  // Returns a promise that resolves to the raw WS message the relay received (for assertions).
  function mockRelayRespond(response: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      mockRelaySocket.once('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        mockRelaySocket.send(JSON.stringify({ id: message.id, ...response }));
        resolve(message);
      });
    });
  }

  // ── navigate ────────────────────────────────────────────────────────────────

  it('navigate tool sends correct WS request and returns result', async () => {
    const requestSeen = mockRelayRespond({
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
    const requestSeen = mockRelayRespond({
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
    const requestSeen = mockRelayRespond({
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
    const requestSeen = mockRelayRespond({
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

    const requestSeen = mockRelayRespond({
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

  // ── view_current_site ────────────────────────────────────────────────────────

  it('view_current_site tool sends correct WS request and returns result', async () => {
    const requestSeen = mockRelayRespond({
      type: 'result',
      data: { id: 42, url: 'https://example.com', title: 'Example', status: 'complete', active: true, faviconUrl: null },
    });

    const toolResult = await callTool(mcpClient, { name: 'view_current_site', arguments: {} });

    const request = await requestSeen;

    expect(request.type).toBe('view_current_site');

    expect(toolResult.isError).toBeFalsy();
    expect(toolResult.content[0].text).toContain('example.com');
  });

  // ── error handling ────────────────────────────────────────────────────────────

  it('relay error response is returned as an MCP error result', async () => {
    mockRelayRespond({
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
