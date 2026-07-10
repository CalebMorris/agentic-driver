import { WebSocket } from 'ws';
import { type Logger, noopLogger } from './logger';

type RelayResponse = Record<string, unknown>;
type SendOptions = {
  // Per-request response timeout in ms; 0 disables the timeout entirely.
  timeoutMs?: number;
};
type PendingRequest = {
  resolver: (response: RelayResponse) => void;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout> | undefined;
};
type QueuedSend = {
  action: Record<string, unknown>;
  resolve: (response: RelayResponse) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
  requestTimeoutMs: number;
};

const RECONNECT_MAX_DELAY_MS = 30_000;
const DEFAULT_SEND_QUEUE_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export type RelayClientOptions = {
  logger?: Logger;
  reconnectBaseDelayMs?: number;
  sendQueueTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class RelayClient {
  private socket: WebSocket | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private sendQueue: QueuedSend[] = [];
  private nextId = 0;
  private destroyed = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly sendQueueTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: Logger;
  private currentReconnectDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    options: RelayClientOptions = {},
  ) {
    this.logger = options.logger ?? noopLogger;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 1_000;
    this.sendQueueTimeoutMs = options.sendQueueTimeoutMs ?? DEFAULT_SEND_QUEUE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.currentReconnectDelay = this.reconnectBaseDelayMs;
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
        clearTimeout(pending.timeoutHandle);
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
        clearTimeout(pending.timeoutHandle);
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

  private transmit(action: Record<string, unknown>, resolve: (response: RelayResponse) => void, timeoutMs: number): void {
    const requestId = String(++this.nextId);
    // Capture only the type so the timer closure does not retain the full payload.
    const actionType = action.type;
    this.logger.info({ requestId, actionType }, 'relay_send');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        this.logger.error({ requestId, actionType, timeoutMs }, 'relay_timeout');
        resolve({ id: requestId, type: 'error', code: 'RELAY_TIMEOUT', message: `Relay did not respond within ${timeoutMs}ms` });
      }, timeoutMs);
    }
    this.pendingRequests.set(requestId, { resolver: resolve, startedAt: Date.now(), timeoutHandle });
    this.socket!.send(JSON.stringify({ id: requestId, ...action }));
  }

  private drainSendQueue(): void {
    const queued = this.sendQueue.splice(0);
    for (const item of queued) {
      clearTimeout(item.timeoutHandle);
      this.transmit(item.action, item.resolve, item.requestTimeoutMs);
    }
  }

  send(action: Record<string, unknown>, options?: SendOptions): Promise<RelayResponse> {
    const requestTimeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.transmit(action, resolve, requestTimeoutMs);
        return;
      }
      const timeoutHandle = setTimeout(() => {
        this.sendQueue = this.sendQueue.filter((queued) => queued !== item);
        reject(new Error('Timed out waiting to connect to relay'));
      }, this.sendQueueTimeoutMs);
      const item: QueuedSend = { action, resolve, reject, timeoutHandle, requestTimeoutMs };
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
