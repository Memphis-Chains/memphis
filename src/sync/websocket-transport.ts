import type { SyncEnvelope } from './protocol.js';
import type { SyncTransport } from './transport.js';

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
 * WebSocket-based transport for direct P2P sync.
 * Fixes B1: checks readyState before registering 'open' listener to avoid race condition.
 * Fixes B2: stores messageHandler reference and removes it in close() to prevent memory leak.
 */
export class WebSocketTransport implements SyncTransport {
  private socket: SocketLike | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private messageHandler: ((...args: any[]) => void) | null = null;
  private messageListeners: Array<(envelope: SyncEnvelope) => void> = [];
  private closed = false;

  constructor(private readonly url: string) {}

  async send(envelope: SyncEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error('WebSocketTransport is closed');
    }
    if (!this.socket) {
      const WebSocketCtor = websocketCtor();
      this.socket = new WebSocketCtor(this.url);
    }

    // B1 fix: check if already open before registering listener
    if (this.socket.readyState === WS_OPEN) {
      this.socket.send(JSON.stringify(envelope));
      return;
    }

    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('WebSocketTransport is closed'));
        return;
      }

      const handleOpen = () => {
        this.socket!.send(JSON.stringify(envelope));
        resolve();
      };

      const handleError = () => {
        reject(new Error('WebSocket transport error'));
      };

      this.socket!.addEventListener('open', handleOpen);
      this.socket!.addEventListener('error', handleError);

      // Clean up listeners after first open (success or failure)
      const cleanup = () => {
        this.socket!.removeEventListener('open', handleOpen);
        this.socket!.removeEventListener('error', handleError);
      };

      // Once open handler fires, clean up both listeners
      this.socket!.addEventListener('open', cleanup);
    });
  }

  onMessage(handler: (envelope: SyncEnvelope) => void): void {
    if (this.closed) {
      throw new Error('WebSocketTransport is closed');
    }

    this.messageListeners.push(handler);

    if (!this.socket) {
      const WebSocketCtor = websocketCtor();
      this.socket = new WebSocketCtor(this.url);
    }

    // B2 fix: reuse same handler reference, remove previous one if exists
    if (this.messageHandler) {
      this.socket.removeEventListener('message', this.messageHandler);
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

    this.socket.addEventListener('message', this.messageHandler);
  }

  close(): void {
    this.closed = true;

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
