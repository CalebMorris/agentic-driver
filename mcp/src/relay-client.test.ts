import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { RelayClient } from './relay-client';
import { createTestLogger } from './test-helpers';

function waitForRelayProcess(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

const TEST_PORT = 9996;
const LOGGING_TEST_PORT = 9994;

const PINO_INFO = 30;
const PINO_ERROR = 50;

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
    client.close();
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
    client.close();
  });

  it('auto-reconnects after the relay drops the connection', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`, 50);
    await client.connect();
    const serverSocket = await serverSocketPromise;

    // Simulate relay dropping the connection (the WSS stays running).
    serverSocket.terminate();
    await waitForRelayProcess();
    expect(client.isConnected()).toBe(false);

    // Base delay is 50ms + up to 50ms jitter; wait 300ms to be safe.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    expect(client.isConnected()).toBe(true);
    client.close();
  });

  it('does not reconnect after explicit close()', async () => {
    await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`, 50);
    await client.connect();

    client.close();

    // Wait longer than the reconnect delay to confirm no reconnect happens.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    expect(client.isConnected()).toBe(false);
  });

  it('send() queues while disconnected and resolves after reconnect', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`, 50);
    await client.connect();
    const serverSocket = await serverSocketPromise;

    // Drop the connection; the WSS stays up so the client can reconnect.
    serverSocket.terminate();
    await waitForRelayProcess();

    // Arrange for the server to reply once the client reconnects and sends.
    wss.once('connection', (newServerSocket) => {
      newServerSocket.once('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        newServerSocket.send(JSON.stringify({ id: message.id, type: 'result', data: {} }));
      });
    });

    const pending = client.send({ type: 'check_status' });

    // Base delay is 50ms + up to 50ms jitter; wait 300ms to be safe.
    const response = await Promise.race([
      pending,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out')), 500)),
    ]);

    expect(response.type).toBe('result');
    client.close();
  });

  it('send() rejects with timeout error when relay never comes back', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    // sendQueueTimeoutMs = 100ms so the test is fast.
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`, 50, 100);
    await client.connect();
    const serverSocket = await serverSocketPromise;

    serverSocket.terminate();
    await waitForRelayProcess();

    // Close the server so reconnect attempts fail.
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    await expect(client.send({ type: 'check_status' })).rejects.toThrow('Timed out waiting to connect to relay');
    client.close();
  });

  it('close() rejects queued sends', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const client = new RelayClient(`ws://localhost:${TEST_PORT}`, 50);
    await client.connect();
    const serverSocket = await serverSocketPromise;

    serverSocket.terminate();
    await waitForRelayProcess();

    const pending = client.send({ type: 'check_status' });
    client.close();

    await expect(pending).rejects.toThrow('Relay client closed');
  });
});

describe('RelayClient — structured logging', () => {
  let wss: WebSocketServer;

  afterEach(async () => {
    if (wss) {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  });

  async function startServer(): Promise<{ serverSocket: Promise<WebSocket> }> {
    wss = new WebSocketServer({ port: LOGGING_TEST_PORT });
    await new Promise<void>((resolve) => {
      if (wss.address()) resolve();
      else wss.once('listening', resolve);
    });
    const serverSocket = new Promise<WebSocket>((resolve) => {
      wss.once('connection', resolve);
    });
    return { serverSocket };
  }

  it('logs relay_connect on successful connection', async () => {
    await startServer();
    const { logger, lines } = createTestLogger();
    const client = new RelayClient(`ws://localhost:${LOGGING_TEST_PORT}`, logger);
    await client.connect();

    expect(lines).toContainEqual(expect.objectContaining({ level: PINO_INFO, msg: 'relay_connect' }));
    client.close();
  });

  it('logs relay_send when sending an action', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const { logger, lines } = createTestLogger();
    const client = new RelayClient(`ws://localhost:${LOGGING_TEST_PORT}`, logger);
    await client.connect();

    const serverSocket = await serverSocketPromise;
    const pending = client.send({ type: 'navigate', url: 'https://example.com' });
    serverSocket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      serverSocket.send(JSON.stringify({ id: message.id, type: 'result', data: {} }));
    });
    await pending;

    const sendLog = lines.find((line) => line.msg === 'relay_send');
    expect(sendLog).toBeDefined();
    expect(sendLog?.level).toBe(PINO_INFO);
    expect(sendLog?.actionType).toBe('navigate');
    client.close();
  });

  it('logs relay_receive info on successful response', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const { logger, lines } = createTestLogger();
    const client = new RelayClient(`ws://localhost:${LOGGING_TEST_PORT}`, logger);
    await client.connect();

    const serverSocket = await serverSocketPromise;
    serverSocket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      serverSocket.send(JSON.stringify({ id: message.id, type: 'result', data: {} }));
    });
    await client.send({ type: 'screenshot' });

    const receiveLog = lines.find((line) => line.msg === 'relay_receive');
    expect(receiveLog).toBeDefined();
    expect(receiveLog?.level).toBe(PINO_INFO);
    expect(receiveLog?.responseType).toBe('result');
    expect(typeof receiveLog?.durationMs).toBe('number');
    client.close();
  });

  it('logs relay_receive error on error response', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const { logger, lines } = createTestLogger();
    const client = new RelayClient(`ws://localhost:${LOGGING_TEST_PORT}`, logger);
    await client.connect();

    const serverSocket = await serverSocketPromise;
    serverSocket.once('message', (data) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      serverSocket.send(JSON.stringify({ id: message.id, type: 'error', code: 'ELEMENT_NOT_FOUND', message: 'No element' }));
    });
    await client.send({ type: 'click', selector: '#missing' });

    const receiveLog = lines.find((line) => line.msg === 'relay_receive');
    expect(receiveLog).toBeDefined();
    expect(receiveLog?.level).toBe(PINO_ERROR);
    expect(receiveLog?.code).toBe('ELEMENT_NOT_FOUND');
    client.close();
  });

  it('logs relay_disconnect when connection closes', async () => {
    const { serverSocket: serverSocketPromise } = await startServer();
    const { logger, lines } = createTestLogger();
    const client = new RelayClient(`ws://localhost:${LOGGING_TEST_PORT}`, logger);
    await client.connect();

    const serverSocket = await serverSocketPromise;
    serverSocket.close();
    await waitForRelayProcess();

    expect(lines).toContainEqual(expect.objectContaining({ level: PINO_INFO, msg: 'relay_disconnect' }));
  });
});
