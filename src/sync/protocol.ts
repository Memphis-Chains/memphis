import type { SyncTransport } from './transport.js';
import { WebSocketTransport } from './websocket-transport.js';
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

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * SyncProtocol — transport-agnostic sync messaging.
 *
 * Uses a SyncTransport for the actual communication.
 * For WebSocket (direct P2P), pass a WebSocketTransport.
 * For Matrix (federated rooms), pass a MatrixTransport.
 *
 * The protocol handles request-response semantics on top of the transport.
 * EC4: Uses envelope.id for message deduplication.
 */
export class SyncProtocol {
  private transport: SyncTransport | null = null;

  constructor(private readonly senderDid: string, transport?: SyncTransport) {
    if (transport) {
      this.transport = transport;
    }
  }

  /**
   * Set or replace the transport.
   */
  setTransport(transport: SyncTransport): void {
    this.transport = transport;
  }

  /**
   * Send a request and wait for response.
   * Uses the configured transport if available.
   * Falls back to WebSocketTransport for backward compatibility if url is provided.
   */
  async sendRequest<TReq, TRes>(
    url: string,
    type: SyncMessageType,
    payload: TReq,
    timeoutMs = 3000,
  ): Promise<SyncEnvelope<TRes>> {
    // Use configured transport, or create WebSocketTransport for the URL
    const transport = this.transport ?? new WebSocketTransport(url);

    const request: SyncEnvelope<TReq> = {
      id: randomId(),
      type,
      senderDid: this.senderDid,
      ts: new Date().toISOString(),
      payload,
    };

    // For WebSocketTransport (direct connection), we can do request-response
    // For MatrixTransport (room-based), this is fire-and-forget with response via onMessage
    // EC4: Use envelope.id to match responses to requests
    const responsePromise = new Promise<SyncEnvelope<TRes>>((resolve, reject) => {
      let settled = false;
      const markSettled = () => {
        if (settled) return;
        settled = true;
      };

      const timeout = setTimeout(() => {
        markSettled();
        // Don't close transport on timeout — it may be shared
        reject(new Error(`sync request timeout (${type})`));
      }, timeoutMs);

      // Listen for response with matching id
      // EC4: dedupe by envelope.id
      const handler = (envelope: SyncEnvelope) => {
        // Only accept responses to our request
        if (envelope.id !== request.id) return;
        // Only accept acks or error responses
        if (envelope.type !== 'sync.ack' && envelope.type !== 'sync.error') return;

        clearTimeout(timeout);
        markSettled();
        resolve(envelope as SyncEnvelope<TRes>);
      };

      transport.onMessage(handler);
    });

    // Send the request
    await transport.send(request);

    return responsePromise;
  }
}
