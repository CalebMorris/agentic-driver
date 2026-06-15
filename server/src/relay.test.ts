import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createRelayServer, RelayServer } from './relay';

const TEST_PORT = 9998;

function connectClient(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${TEST_PORT}${path}`);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function waitForMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

function closeClient(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('close', resolve);
    socket.close();
  });
}

describe('createRelayServer', () => {
  let relay: RelayServer;

  beforeEach(async () => {
    relay = createRelayServer(TEST_PORT);
    await new Promise<void>((resolve) => {
      if (relay.wss.address()) resolve();
      else relay.wss.once('listening', resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => relay.wss.close(() => resolve()));
  });

  it('relays messages from agent to plugin', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    const message = { id: '1', type: 'read_html' };
    const receivePromise = waitForMessage(pluginSocket);
    agentSocket.send(JSON.stringify(message));

    const received = await receivePromise;
    expect(received).toEqual(message);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('relays messages from plugin to agent', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    const response = { id: '1', type: 'result', data: { html: '<html></html>' } };
    const receivePromise = waitForMessage(agentSocket);
    pluginSocket.send(JSON.stringify(response));

    const received = await receivePromise;
    expect(received).toEqual(response);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('returns error to agent when plugin is not connected', async () => {
    const agentSocket = await connectClient('/agent');

    const message = { id: '42', type: 'read_html' };
    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify(message));

    const received = await receivePromise as { id: string; type: string; code: string };
    expect(received.id).toBe('42');
    expect(received.type).toBe('error');
    expect(received.code).toBe('UNKNOWN');

    await closeClient(agentSocket);
  });

  it('closes unknown client paths immediately', async () => {
    const socket = new WebSocket(`ws://localhost:${TEST_PORT}/unknown`);
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
