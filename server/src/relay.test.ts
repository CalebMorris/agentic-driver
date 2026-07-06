import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import pino from 'pino';
import { createRelayServer, RelayServer } from './relay';

const TEST_PORT = 9998;

function connectClient(path: string, port = TEST_PORT): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}${path}`);
    socket.on('open', () => resolve(socket));
    socket.on('error', reject);
  });
}

function createCapturingLogger(): { logger: pino.Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = {
    write(line: string) {
      entries.push(JSON.parse(line));
    },
  };
  return { logger: pino({ level: 'info' }, stream), entries };
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
    if (relay.wss.address() !== null) {
      await new Promise<void>((resolve) => relay.wss.close(() => resolve()));
    }
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

  // ── closeGracefully ─────────────────────────────────────────────────────────

  it('closeGracefully: sends server_closing to plugin before closing', async () => {
    const pluginSocket = await connectClient('/plugin');

    const receivePromise = waitForMessage(pluginSocket);
    await relay.closeGracefully();

    const received = await receivePromise as { type: string };
    expect(received.type).toBe('server_closing');
  });

  it('closeGracefully: resolves without error when no plugin is connected', async () => {
    await expect(relay.closeGracefully()).resolves.toBeUndefined();
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

describe('createRelayServer logging', () => {
  const LOG_TEST_PORT = 9997;
  let relay: RelayServer;
  let entries: Array<Record<string, unknown>>;

  beforeEach(async () => {
    const capture = createCapturingLogger();
    entries = capture.entries;
    relay = createRelayServer(LOG_TEST_PORT, capture.logger);
    await new Promise<void>((resolve) => {
      if (relay.wss.address()) resolve();
      else relay.wss.once('listening', resolve);
    });
  });

  afterEach(async () => {
    if (relay.wss.address() !== null) {
      await new Promise<void>((resolve) => relay.wss.close(() => resolve()));
    }
  });

  it('logs a warn when sending DRIVING_DISABLED error to the agent', async () => {
    const agentSocket = await connectClient('/agent', LOG_TEST_PORT);

    const receivePromise = waitForMessage(agentSocket);
    agentSocket.send(JSON.stringify({ id: '30', type: 'read_html' }));
    await receivePromise;

    const entry = entries.find((e) => e.msg === 'agent_error_sent');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe(40);
    expect(entry?.code).toBe('DRIVING_DISABLED');

    await closeClient(agentSocket);
  });

  it('logs a warn when plugin is not connected for a driving-enabled request', async () => {
    const pluginSocket = await connectClient('/plugin', LOG_TEST_PORT);
    const agentSocket = await connectClient('/agent', LOG_TEST_PORT);

    pluginSocket.send(JSON.stringify({ type: 'driving_enabled', tabId: 1 }));
    await waitForRelayProcess();

    agentSocket.send(JSON.stringify({ id: '31', type: 'handoff', reason: 'Test' }));
    await waitForRelayProcess();

    const receivePromise = waitForMessage(agentSocket);
    await closeClient(pluginSocket);
    await receivePromise;

    const entry = entries.find((e) => e.msg === 'agent_error_sent' && e.code === 'UNKNOWN');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe(40);

    await closeClient(agentSocket);
  });

  it('logs an error when a client socket emits an error', async () => {
    const agentSocket = await connectClient('/agent', LOG_TEST_PORT);

    const serverSideSocket = Array.from(relay.wss.clients)[0];
    serverSideSocket.emit('error', new Error('boom'));

    const entry = entries.find((e) => e.msg === 'socket_error');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe(50);
    expect(entry?.clientPath).toBe('/agent');

    await closeClient(agentSocket);
  });

  it('logs an error when the WebSocketServer emits an error', async () => {
    const capture = createCapturingLogger();
    const conflicting = createRelayServer(LOG_TEST_PORT, capture.logger);
    await waitForRelayProcess();

    const entry = capture.entries.find((e) => e.msg === 'wss_error');
    expect(entry).toBeDefined();
    expect(entry?.level).toBe(50);

    await new Promise<void>((resolve) => conflicting.wss.close(() => resolve()));
  });
});
