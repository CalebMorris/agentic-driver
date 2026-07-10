import pino from 'pino';
import { Writable } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory';
import { type Logger } from './logger';
import { RelayClient, type RelayClientOptions } from './relay-client';
import { createMcpServer } from './server';

export function createTestLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: pino({ level: 'trace' }, stream), lines };
}

// Start a mock relay WSS on the given port and connect a RelayClient to it.
// Returns the server, the connected client, and the server-side socket for
// scripting relay responses in tests.
export async function startMockRelay(
  port: number,
  relayOptions?: RelayClientOptions
): Promise<{ wss: WebSocketServer; relayClient: RelayClient; relaySocket: WebSocket }> {
  const wss = new WebSocketServer({ port });
  await new Promise<void>((resolve) => {
    if (wss.address()) resolve();
    else wss.once('listening', resolve);
  });
  const socketConnected = new Promise<WebSocket>((resolve) => {
    wss.once('connection', resolve);
  });
  const relayClient = new RelayClient(`ws://localhost:${port}`, relayOptions);
  await relayClient.connect();
  const relaySocket = await socketConnected;
  return { wss, relayClient, relaySocket };
}

// Wire an in-process MCP client to a server backed by the given RelayClient.
export async function connectMcpClient(relayClient: RelayClient, logger?: Logger): Promise<Client> {
  const mcpServer = createMcpServer(relayClient, logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return client;
}

// Pre-register a one-shot relay response for the next incoming message,
// optionally delayed to simulate a slow relay. Returns a promise resolving to
// the raw message the relay received (for assertions).
export function mockRelayRespond(
  socket: WebSocket,
  response: Record<string, unknown>,
  delayMs = 0
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      const reply = () => socket.send(JSON.stringify({ id: message.id, ...response }));
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
      resolve(message);
    });
  });
}
