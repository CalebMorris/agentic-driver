import { WebSocket } from 'ws';

type RelayResponse = Record<string, unknown>;
type PendingResolver = (response: RelayResponse) => void;

export class RelayClient {
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingResolver> = new Map();
  private nextId = 0;

  constructor(private readonly url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);

      this.socket.on('open', () => resolve());
      this.socket.on('error', reject);

      this.socket.on('message', (data) => {
        const response = JSON.parse(data.toString()) as RelayResponse;
        const requestId = response.id as string;
        const resolver = this.pendingRequests.get(requestId);
        if (resolver) {
          this.pendingRequests.delete(requestId);
          resolver(response);
        }
      });

      this.socket.on('close', () => {
        this.socket = null;
        for (const [requestId, resolver] of this.pendingRequests) {
          resolver({ id: requestId, type: 'error', code: 'RELAY_DISCONNECTED', message: 'Relay connection closed' });
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
      this.pendingRequests.set(requestId, resolve);
      this.socket.send(JSON.stringify({ id: requestId, ...action }));
    });
  }

  close(): void {
    this.socket?.close();
  }
}
