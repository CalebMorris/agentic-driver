import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

export interface RelayServer {
  wss: WebSocketServer;
  waitForPlugin: () => Promise<void>;
}

export function createRelayServer(port: number): RelayServer {
  const wss = new WebSocketServer({ port });

  let pluginSocket: WebSocket | null = null;
  let agentSocket: WebSocket | null = null;
  let drivingEnabled = false;
  let pendingHandoffId: string | null = null;

  let resolvePluginConnected: (() => void) | null = null;
  const pluginConnected = new Promise<void>((resolve) => {
    resolvePluginConnected = resolve;
  });

  function sendToAgent(payload: object): void {
    if (agentSocket?.readyState === WebSocket.OPEN) {
      agentSocket.send(JSON.stringify(payload));
    }
  }

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const clientPath = request.url;

    if (clientPath === '/plugin') {
      pluginSocket = socket;
      resolvePluginConnected?.();
      console.log('[relay] Plugin connected');

      socket.on('message', (data: Buffer) => {
        let parsed: { type?: string; id?: string };
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }

        if (parsed.type === 'driving_enabled') {
          drivingEnabled = true;
          console.log('[relay] Driving enabled');
          return;
        }
        if (parsed.type === 'driving_disabled') {
          drivingEnabled = false;
          console.log('[relay] Driving disabled');
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
        if (pendingHandoffId !== null) {
          sendToAgent({
            id: pendingHandoffId,
            type: 'error',
            code: 'UNKNOWN',
            message: 'Plugin disconnected during handoff',
          });
          pendingHandoffId = null;
        }
        console.log('[relay] Plugin disconnected');
      });

    } else if (clientPath === '/agent') {
      agentSocket = socket;
      console.log('[relay] Agent connected');

      socket.on('message', (data: Buffer) => {
        let message: { id?: string; type?: string };
        try {
          message = JSON.parse(data.toString());
        } catch {
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
        console.log('[relay] Agent disconnected');
      });

    } else {
      socket.close(4000, 'Unknown client type. Connect via /plugin or /agent.');
    }
  });

  return { wss, waitForPlugin: () => pluginConnected };
}
