import { WebSocket } from 'ws';
import { type Logger, noopLogger } from './logger';

type RelayResponse = Record<string, unknown>;
type PendingRequest = {
  resolver: (response: RelayResponse) => void;
  startedAt: number;
};

export class RelayClient {
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private nextId = 0;

  constructor(
    private readonly url: string,
    private readonly logger: Logger = noopLogger,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);

      this.socket.on('open', () => {
        this.logger.info({ url: this.url }, 'relay_connect');
        resolve();
      });
      this.socket.on('error', reject);

      this.socket.on('message', (data) => {
        const response = JSON.parse(data.toString()) as RelayResponse;
        const requestId = response.id as string;
        const pending = this.pendingRequests.get(requestId);
        if (pending) {
          this.pendingRequests.delete(requestId);
          const durationMs = Date.now() - pending.startedAt;
          if (response.type === 'error') {
            this.logger.error({ requestId, code: response.code, message: response.message, durationMs }, 'relay_receive');
          } else {
            this.logger.info({ requestId, responseType: response.type, durationMs }, 'relay_receive');
          }
          pending.resolver(response);
        }
      });

      this.socket.on('close', () => {
        this.socket = null;
        this.logger.info({ url: this.url }, 'relay_disconnect');
        for (const [requestId, pending] of this.pendingRequests) {
          pending.resolver({ id: requestId, type: 'error', code: 'RELAY_DISCONNECTED', message: 'Relay connection closed' });
        }
        this.pendingRequests.clear();
      });
    });
  }

  send(action: Record<string, unknown>): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Not connected to relay'));
        return;
      }
      const requestId = String(++this.nextId);
      this.logger.info({ requestId, actionType: action.type }, 'relay_send');
      this.pendingRequests.set(requestId, { resolver: resolve, startedAt: Date.now() });
      this.socket.send(JSON.stringify({ id: requestId, ...action }));
    });
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.socket?.close();
  }
}
