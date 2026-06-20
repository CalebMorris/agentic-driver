import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayClient } from './relay-client';

function waitForRelayProcess(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

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

  it('isConnected returns false before connecting', () => {
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`);
    expect(client.isConnected()).toBe(false);
  });

  it('isConnected returns true after connecting', async () => {
    await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    client.close();
  });

  it('isConnected returns false after relay socket closes', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`);
    await client.connect();
    const serverSocket = await serverSocketPromise;
    serverSocket.close();
    await waitForRelayProcess();
    expect(client.isConnected()).toBe(false);
  });

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
