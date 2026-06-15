import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';

export function createRelayServer(port: number): WebSocketServer {
  const wss = new WebSocketServer({ port });

  let pluginSocket: WebSocket | null = null;
  let agentSocket: WebSocket | null = null;

  function sendToAgent(payload: object): void {
    if (agentSocket?.readyState === WebSocket.OPEN) {
      agentSocket.send(JSON.stringify(payload));
    }
  }

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    const clientPath = request.url;

    if (clientPath === '/plugin') {
      pluginSocket = socket;
      console.log('[relay] Plugin connected');

      socket.on('message', (data: Buffer) => {
        if (agentSocket?.readyState === WebSocket.OPEN) {
          agentSocket.send(data.toString());
        }
      });

      socket.on('close', () => {
        pluginSocket = null;
        console.log('[relay] Plugin disconnected');
      });

    } else if (clientPath === '/agent') {
      agentSocket = socket;
      console.log('[relay] Agent connected');

      socket.on('message', (data: Buffer) => {
        if (pluginSocket?.readyState === WebSocket.OPEN) {
          pluginSocket.send(data.toString());
        } else {
          try {
            const message = JSON.parse(data.toString()) as { id?: string };
            sendToAgent({
              id: message.id ?? '',
              type: 'error',
              code: 'UNKNOWN',
              message: 'Plugin is not connected',
            });
          } catch {
            // malformed JSON — drop silently
          }
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

  return wss;
}
