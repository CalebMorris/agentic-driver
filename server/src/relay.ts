import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import pino from 'pino';

export interface RelayServer {
  wss: WebSocketServer;
  /** Resolves when the plugin is connected (immediately if already connected). */
  waitForPlugin: () => Promise<void>;
  /** Returns true if the plugin WebSocket is currently open. */
  isPluginConnected: () => boolean;
  /** Resolves on the next plugin connection (immediately if already connected). */
  waitForPluginConnect: () => Promise<void>;
  /** Resolves on the next plugin disconnection (immediately if not connected). */
  waitForPluginDisconnect: () => Promise<void>;
  /** Sends server_closing to the plugin, closes all connections, then closes the WSS. */
  closeGracefully: () => Promise<void>;
}

export function createRelayServer(port: number, logger = pino({ level: 'silent' })): RelayServer {
  const wss = new WebSocketServer({ port });

  let pluginSocket: WebSocket | null = null;
  let agentSocket: WebSocket | null = null;
  let drivingEnabled = false;
  let pendingHandoffId: string | null = null;

  const pluginConnectWaiters: Array<() => void> = [];
  const pluginDisconnectWaiters: Array<() => void> = [];

  function isPluginConnected(): boolean {
    return pluginSocket !== null && pluginSocket.readyState === WebSocket.OPEN;
  }

  function waitForPluginConnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (isPluginConnected()) { resolve(); return; }
      pluginConnectWaiters.push(resolve);
    });
  }

  function waitForPluginDisconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!isPluginConnected()) { resolve(); return; }
      pluginDisconnectWaiters.push(resolve);
    });
  }

  function sendToAgent(payload: object): void {
    if (agentSocket?.readyState === WebSocket.OPEN) {
      agentSocket.send(JSON.stringify(payload));
    }
  }

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const clientPath = request.url;

    if (clientPath === '/plugin') {
      pluginSocket = socket;
      pluginConnectWaiters.splice(0).forEach(fn => fn());
      logger.info('plugin_connected');

      socket.on('message', (data: Buffer) => {
        let parsed: { type?: string; id?: string };
        try {
          parsed = JSON.parse(data.toString());
        } catch (error) {
          logger.warn({ err: error }, 'plugin_message_parse_error');
          return;
        }

        if (parsed.type === 'driving_enabled') {
          drivingEnabled = true;
          logger.info('driving_enabled');
          return;
        }
        if (parsed.type === 'driving_disabled') {
          drivingEnabled = false;
          logger.info('driving_disabled');
          return;
        }
        if (parsed.type === 'handoff_complete') {
          if (pendingHandoffId !== null) {
            sendToAgent({ id: pendingHandoffId, type: 'result', data: { status: 'complete' } });
            pendingHandoffId = null;
          }
          return;
        }

        // Suppress the intermediate waiting_for_human response from the plugin
        if (pendingHandoffId !== null && parsed.id === pendingHandoffId) {
          return;
        }

        if (agentSocket?.readyState === WebSocket.OPEN) {
          agentSocket.send(data.toString());
        }
      });

      socket.on('close', () => {
        pluginSocket = null;
        drivingEnabled = false;
        pluginDisconnectWaiters.splice(0).forEach(fn => fn());
        if (pendingHandoffId !== null) {
          sendToAgent({
            id: pendingHandoffId,
            type: 'error',
            code: 'UNKNOWN',
            message: 'Plugin disconnected during handoff',
          });
          pendingHandoffId = null;
        }
        logger.info('plugin_disconnected');
      });

    } else if (clientPath === '/agent') {
      agentSocket = socket;
      logger.info('agent_connected');

      socket.on('message', (data: Buffer) => {
        let message: { id?: string; type?: string };
        try {
          message = JSON.parse(data.toString());
        } catch (error) {
          logger.warn({ err: error }, 'agent_message_parse_error');
          return;
        }

        logger.info({ messageType: message.type }, 'agent_message');

        if (message.type === 'status') {
          sendToAgent({
            id: message.id ?? '',
            type: 'result',
            data: { pluginConnected: isPluginConnected(), drivingEnabled },
          });
          return;
        }

        if (!drivingEnabled) {
          sendToAgent({
            id: message.id ?? '',
            type: 'error',
            code: 'DRIVING_DISABLED',
            message: 'Driving has not been enabled via the plugin UI',
          });
          return;
        }

        if (message.type === 'handoff') {
          pendingHandoffId = message.id ?? '';
        }

        if (pluginSocket?.readyState === WebSocket.OPEN) {
          pluginSocket.send(data.toString());
        } else {
          sendToAgent({
            id: message.id ?? '',
            type: 'error',
            code: 'UNKNOWN',
            message: 'Plugin is not connected',
          });
        }
      });

      socket.on('close', () => {
        agentSocket = null;
        logger.info('agent_disconnected');
      });

    } else {
      socket.close(4000, 'Unknown client type. Connect via /plugin or /agent.');
    }
  });

  function closeGracefully(): Promise<void> {
    return new Promise((resolve) => {
      if (pluginSocket?.readyState === WebSocket.OPEN) {
        pluginSocket.send(JSON.stringify({ type: 'server_closing' }));
        pluginSocket.close();
      }
      if (agentSocket?.readyState === WebSocket.OPEN) {
        agentSocket.close();
      }
      wss.close(() => resolve());
    });
  }

  return { wss, waitForPlugin: waitForPluginConnect, isPluginConnected, waitForPluginConnect, waitForPluginDisconnect, closeGracefully };
}
