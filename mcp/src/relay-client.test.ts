import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayClient } from './relay-client';

const TEST_PORT = 9996;

describe('RelayClient', () => {
  let wss: WebSocketServer;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  async function startServer(): Promise<{ wss: WebSocketServer; serverSocket: Promise<WebSocket> }> {
    wss = new WebSocketServer({ port: TEST_PORT });
    await new Promise<void>((resolve) => {
      if (wss.address()) resolve();
      else wss.once('listening', resolve);
    });
    const serverSocket = new Promise<WebSocket>((resolve) => {
      wss.once('connection', resolve);
    });
    return { wss, serverSocket };
  }

  it('pending send() resolves with RELAY_DISCONNECTED when the relay socket closes', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();

    const client = new RelayClient(`ws://localhost:${TEST_PORT}`);
    await client.connect();

    const serverSocket = await serverSocketPromise;

    const pending = client.send({ type: 'read_html' });

    serverSocket.close();

    const response = await pending;
    expect(response.type).toBe('error');
    expect(response.code).toBe('RELAY_DISCONNECTED');
  });
});
