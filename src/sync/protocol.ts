import type { Block } from '../memory/chain.js';

export type SyncMessageType =
  | 'sync.hello'
  | 'sync.status'
  | 'sync.push'
  | 'sync.pull'
  | 'sync.ack'
  | 'sync.error';

export type SyncEnvelope<TPayload = unknown> = {
  id: string;
  type: SyncMessageType;
  senderDid: string;
  targetDid?: string;
  ts: string;
  payload: TPayload;
};

export type SyncPushPayload = {
  chain: string;
  blocks: Block[];
};

export type SyncPullPayload = {
  chain: string;
};

export type SyncStatusPayload = {
  chains: Array<{ name: string; blocks: number; lastHash?: string }>;
};

type SocketLike = {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  addEventListener: (event: string, listener: (payload: unknown) => void) => void;
};

type SocketCtor = new (url: string) => SocketLike;

function websocketCtor(): SocketCtor {
  const ctor = globalThis.WebSocket as unknown as SocketCtor | undefined;
  if (!ctor) {
    throw new Error('WebSocket runtime is not available. Use Node.js 20+ or provide a polyfill.');
  }
  return ctor;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class SyncProtocol {
  constructor(private readonly senderDid: string) {}

  async sendRequest<TReq, TRes>(url: string, type: SyncMessageType, payload: TReq, timeoutMs = 3000): Promise<SyncEnvelope<TRes>> {
    const WebSocketCtor = websocketCtor();
    const socket = new WebSocketCtor(url);

    const request: SyncEnvelope<TReq> = {
      id: randomId(),
      type,
      senderDid: this.senderDid,
      ts: new Date().toISOString(),
      payload,
    };

    return new Promise<SyncEnvelope<TRes>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`sync request timeout (${type})`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify(request));
      });

      socket.addEventListener('message', (event) => {
        clearTimeout(timeout);
        const data = event as { data?: string };
        const response = JSON.parse(data.data ?? '{}') as SyncEnvelope<TRes>;
        socket.close();
        resolve(response);
      });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        socket.close();
        reject(new Error(`sync transport error (${type})`));
      });
    });
  }
}
