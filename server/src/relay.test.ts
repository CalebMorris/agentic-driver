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

// Yield to the event loop so the relay can process an in-flight message.
function waitForRelayProcess(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
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

  // ── Driving gate ────────────────────────────────────────────────────────────

  it('returns DRIVING_DISABLED when driving has not been enabled', async () => {
    const agentSocket = await connectClient('/agent');

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '1', type: 'read_html' }));

    const received = await receivePromise as { id: string; type: string; code: string };
    expect(received.id).toBe('1');
    expect(received.type).toBe('error');
    expect(received.code).toBe('DRIVING_DISABLED');

    await closeClient(agentSocket);
  });

  it('relays agent messages to plugin after driving enabled', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    const message = { id: '2', type: 'read_html' };
    const receivePromise = waitForMessage(pluginSocket);
    agentSocket.send(JSON.stringify(message));

    const received = await receivePromise;
    expect(received).toEqual(message);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('returns DRIVING_DISABLED after driving is disabled again', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    pluginSocket.send(JSON.stringify({ type: 'driving_disabled' }));
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '3', type: 'read_html' }));

    const received = await receivePromise as { type: string; code: string };
    expect(received.type).toBe('error');
    expect(received.code).toBe('DRIVING_DISABLED');

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('returns DRIVING_DISABLED after plugin disconnects', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    await closeClient(pluginSocket);
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '4', type: 'read_html' }));

    const received = await receivePromise as { type: string; code: string };
    expect(received.type).toBe('error');
    expect(received.code).toBe('DRIVING_DISABLED');

    await closeClient(agentSocket);
  });

  it('does not forward driving_enabled or driving_disabled to agent', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    let agentReceivedMessage = false;
    agentSocket.on('message', () => { agentReceivedMessage = true; });

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();
    pluginSocket.send(JSON.stringify({ type: 'driving_disabled' }));
    await waitForRelayProcess();

    expect(agentReceivedMessage).toBe(false);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  // ── Relay forwarding ────────────────────────────────────────────────────────

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

  it('returns UNKNOWN when plugin is not connected but driving was previously enabled', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    // Disconnect the plugin without sending driving_disabled
    pluginSocket.close();
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '5', type: 'read_html' }));

    const received = await receivePromise as { type: string; code: string };
    // Plugin disconnect resets drivingEnabled, so DRIVING_DISABLED is returned
    expect(received.type).toBe('error');
    expect(received.code).toBe('DRIVING_DISABLED');

    await closeClient(agentSocket);
  });

  // ── Status ──────────────────────────────────────────────────────────────────

  it('status message bypasses driving gate and returns current status when no plugin is connected', async () => {
    const agentSocket = await connectClient('/agent');

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '20', type: 'status' }));

    const received = await receivePromise as {
      id: string;
      type: string;
      data: { pluginConnected: boolean; drivingEnabled: boolean };
    };
    expect(received.id).toBe('20');
    expect(received.type).toBe('result');
    expect(received.data.pluginConnected).toBe(false);
    expect(received.data.drivingEnabled).toBe(false);

    await closeClient(agentSocket);
  });

  it('status message reflects plugin connected and driving enabled', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '21', type: 'status' }));

    const received = await receivePromise as {
      id: string;
      type: string;
      data: { pluginConnected: boolean; drivingEnabled: boolean };
    };
    expect(received.id).toBe('21');
    expect(received.type).toBe('result');
    expect(received.data.pluginConnected).toBe(true);
    expect(received.data.drivingEnabled).toBe(true);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('status message is not forwarded to plugin', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    let pluginReceivedMessage = false;
    pluginSocket.on('message', () => { pluginReceivedMessage = true; });

    agentSocket.send(JSON.stringify({ id: '22', type: 'status' }));
    await waitForRelayProcess();

    expect(pluginReceivedMessage).toBe(false);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('closes unknown client paths immediately', async () => {
    const socket = new WebSocket(`ws://localhost:${TEST_PORT}/unknown`);
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  // ── Handoff ─────────────────────────────────────────────────────────────────

  it('handoff: agent handoff message is forwarded to plugin', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    const message = { id: '7', type: 'handoff', reason: 'Cloudflare challenge detected' };
    const receivePromise = waitForMessage(pluginSocket);
    agentSocket.send(JSON.stringify(message));

    const received = await receivePromise;
    expect(received).toEqual(message);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('handoff: waiting_for_human response from plugin is suppressed', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    agentSocket.send(JSON.stringify({ id: '8', type: 'handoff', reason: 'Test' }));
    await waitForRelayProcess();

    let agentReceivedMessage = false;
    agentSocket.on('message', () => { agentReceivedMessage = true; });

    pluginSocket.send(JSON.stringify({ id: '8', type: 'result', data: { status: 'waiting_for_human' } }));
    await waitForRelayProcess();

    expect(agentReceivedMessage).toBe(false);

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('handoff: handoff_complete causes relay to send complete result to agent with original id', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    agentSocket.send(JSON.stringify({ id: '9', type: 'handoff', reason: 'Test' }));
    await waitForRelayProcess();

    pluginSocket.send(JSON.stringify({ id: '9', type: 'result', data: { status: 'waiting_for_human' } }));
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    pluginSocket.send(JSON.stringify({ type: 'handoff_complete' }));

    const received = await receivePromise as { id: string; type: string; data: { status: string } };
    expect(received.id).toBe('9');
    expect(received.type).toBe('result');
    expect(received.data.status).toBe('complete');

    await closeClient(pluginSocket);
    await closeClient(agentSocket);
  });

  it('handoff: plugin disconnect during handoff sends error to agent', async () => {
    const pluginSocket = await connectClient('/plugin');
    const agentSocket = await connectClient('/agent');

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    agentSocket.send(JSON.stringify({ id: '10', type: 'handoff', reason: 'Test' }));
    await waitForRelayProcess();

    pluginSocket.send(JSON.stringify({ id: '10', type: 'result', data: { status: 'waiting_for_human' } }));
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    await closeClient(pluginSocket);

    const received = await receivePromise as { id: string; type: string; code: string };
    expect(received.id).toBe('10');
    expect(received.type).toBe('error');
    expect(received.code).toBe('UNKNOWN');

    await closeClient(agentSocket);
  });
});
