import { WebSocket } from 'ws';
import { type Logger, noopLogger } from './logger';

type RelayResponse = Record<string, unknown>;
type PendingRequest = {
  resolver: (response: RelayResponse) => void;
  startedAt: number;
};
type QueuedSend = {
  action: Record<string, unknown>;
  resolve: (response: RelayResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

const RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SEND_QUEUE_TIMEOUT_MS = 30_000;

export class RelayClient {
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private sendQueue: QueuedSend[] = [];
  private nextId = 0;
  private destroyed = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly sendQueueTimeoutMs: number;
  private readonly logger: Logger;
  private currentReconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    loggerOrReconnectMs: Logger | number = noopLogger,
    sendQueueTimeoutMs: number = DEFAULT_SEND_QUEUE_TIMEOUT_MS,
  ) {
    if (typeof loggerOrReconnectMs === 'number') {
      this.reconnectBaseDelayMs = loggerOrReconnectMs;
      this.logger = noopLogger;
    } else {
      this.reconnectBaseDelayMs = 1_000;
      this.logger = loggerOrReconnectMs;
    }
    this.currentReconnectDelay = this.reconnectBaseDelayMs;
    this.sendQueueTimeoutMs = sendQueueTimeoutMs;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.attachSocket(resolve, reject);
    });
  }

  private attachSocket(onOpen?: () => void, onError?: (error: Error) => void): void {
    if (this.destroyed) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on('open', () => {
      this.currentReconnectDelay = this.reconnectBaseDelayMs;
      this.logger.info({ url: this.url }, 'relay_connect');
      onOpen?.();
      this.drainSendQueue();
    });

    socket.on('error', (error) => {
      onError?.(error);
    });

    socket.on('message', (data) => {
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

    socket.on('close', () => {
      this.socket = null;
      this.logger.info({ url: this.url }, 'relay_disconnect');
      for (const [requestId, pending] of this.pendingRequests) {
        pending.resolver({ id: requestId, type: 'error', code: 'RELAY_DISCONNECTED', message: 'Relay connection closed' });
      }
      this.pendingRequests.clear();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const jitter = Math.random() * this.reconnectBaseDelayMs;
    const delay = this.currentReconnectDelay + jitter;
    this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
    this.logger.info({ delayMs: Math.round(delay) }, 'relay_reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attachSocket();
    }, delay);
  }

  private transmit(action: Record<string, unknown>, resolve: (response: RelayResponse) => void): void {
    const requestId = String(++this.nextId);
    this.logger.info({ requestId, actionType: action.type }, 'relay_send');
    this.pendingRequests.set(requestId, { resolver: resolve, startedAt: Date.now() });
    this.socket!.send(JSON.stringify({ id: requestId, ...action }));
  }

  private drainSendQueue(): void {
    const queued = this.sendQueue.splice(0);
    for (const item of queued) {
      clearTimeout(item.timeoutHandle);
      this.transmit(item.action, item.resolve);
    }
  }

  send(action: Record<string, unknown>): Promise<RelayResponse> {
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.transmit(action, resolve);
        return;
      }
      const timeoutHandle = setTimeout(() => {
        this.sendQueue = this.sendQueue.filter((queued) => queued !== item);
        reject(new Error('Timed out waiting to connect to relay'));
      }, this.sendQueueTimeoutMs);
      const item: QueuedSend = { action, resolve, reject, timeoutHandle };
      this.sendQueue.push(item);
    });
  }

  isConnected(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const item of this.sendQueue) {
      clearTimeout(item.timeoutHandle);
      item.reject(new Error('Relay client closed'));
    }
    this.sendQueue = [];
    this.socket?.close();
  }
}
