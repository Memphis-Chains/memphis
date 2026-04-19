/**
 * WebSocket-based transport for direct P2P sync.
 *
 * Fixes B1: checks readyState before registering 'open' listener to avoid race condition.
 * Fixes B2: stores messageHandler reference and removes it in close() to prevent memory leak.
 * EC2: Automatically reconnects on connection loss with exponential backoff.
 * B4: send() retries with exponential backoff via withRetry.
 */

import type { SyncEnvelope } from './protocol.js';
import type { SyncTransport } from './transport.js';
import { withRetry, RetryableError } from '../infra/retry.js';

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  destroy: () => void;
  addEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
};

type SocketCtor = new (url: string) => SocketLike;

const WS_OPEN = 1;

function websocketCtor(): SocketCtor {
  const ctor = globalThis.WebSocket as unknown as SocketCtor | undefined;
  if (!ctor) {
    throw new Error('WebSocket runtime is not available. Use Node.js 20+ or provide a polyfill.');
  }
  return ctor;
}

/**
 * EC2: Reconnect state machine parameters.
 */
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class WebSocketTransport implements SyncTransport {
  private socket: SocketLike | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private messageHandler: ((...args: any[]) => void) | null = null;
  private messageListeners: Array<(envelope: SyncEnvelope) => void> = [];
  private closed = false;
  private reconnectAttempt = 0;
  private reconnecting = false;

  constructor(private readonly url: string) {}

  /**
   * EC2: Connect to the WebSocket URL.
   * If already connected or reconnecting, this is a no-op.
   * Starts the reconnect loop if the connection drops.
   */
  async connect(): Promise<void> {
    if (this.closed || this.socket?.readyState === WS_OPEN) return;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.setupSocket();
  }

  /**
   * EC2: Internal socket setup with reconnect on close.
   */
  private setupSocket(): void {
    if (this.closed) return;

    const WebSocketCtor = websocketCtor();
    this.socket = new WebSocketCtor(this.url);

    this.socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.reconnecting = false;
    });

    this.socket.addEventListener('close', () => {
      if (this.closed) return;
      if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;

      this.reconnecting = true;
      this.reconnectAttempt++;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
        MAX_RECONNECT_DELAY_MS,
      );
      setTimeout(() => this.setupSocket(), delay);
    });

    // Re-attach message handler on new socket
    if (this.messageHandler) {
      this.socket.addEventListener('message', this.messageHandler);
    }
  }

  /**
   * B4: Sends with exponential backoff retry.
   */
  async send(envelope: SyncEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error('WebSocketTransport is closed');
    }

    return withRetry(async () => {
      if (!this.socket) {
        const WebSocketCtor = websocketCtor();
        this.socket = new WebSocketCtor(this.url);
      }

      if (this.socket.readyState === WS_OPEN) {
        this.socket.send(JSON.stringify(envelope));
        return;
      }

      // Socket not yet open — wait for it
      await new Promise<void>((resolve, reject) => {
        if (this.closed) {
          reject(new Error('WebSocketTransport is closed'));
          return;
        }

        const handleOpen = () => {
          this.socket!.send(JSON.stringify(envelope));
          resolve();
        };

        const handleError = () => {
          reject(new RetryableError('WebSocket transport error', 0));
        };

        this.socket!.addEventListener('open', handleOpen);
        this.socket!.addEventListener('error', handleError);

        // One-time cleanup after first open
        const cleanup = () => {
          this.socket!.removeEventListener('open', handleOpen);
          this.socket!.removeEventListener('error', handleError);
        };
        this.socket!.addEventListener('open', cleanup);
      });
    });
  }

  onMessage(handler: (envelope: SyncEnvelope) => void): void {
    if (this.closed) {
      throw new Error('WebSocketTransport is closed');
    }

    this.messageListeners.push(handler);

    // Capture socket reference locally to prevent race with close().
    if (!this.socket) {
      const WebSocketCtor = websocketCtor();
      this.socket = new WebSocketCtor(this.url);
    }
    const socket = this.socket; // local copy, race-safe

    // B2 fix: reuse same handler reference, remove previous one if exists
    if (this.messageHandler) {
      socket.removeEventListener('message', this.messageHandler);
    }

    this.messageHandler = (event: unknown) => {
      try {
        const e = event as { data?: string };
        const data = e.data ?? '{}';
        const envelope = JSON.parse(data) as SyncEnvelope;
        // Dispatch to all registered handlers
        for (const listener of this.messageListeners) {
          listener(envelope);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    socket.addEventListener('message', this.messageHandler);
  }

  close(): void {
    this.closed = true;
    this.reconnecting = false;

    if (this.messageHandler && this.socket) {
      // B2 fix: remove listener on close to prevent memory leak
      this.socket.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    this.messageListeners = [];

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }
}
