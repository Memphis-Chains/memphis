/**
 * Matrix sync adapter — implements SyncTransport for Matrix rooms.
 *
 * Uses Matrix as the transport layer for Memphis sync protocol.
 * Each sync envelope is sent as a Matrix room message.
 *
 * EC2: connect() starts a polling loop that auto-reconnects on error.
 * B4: sendMessage uses exponential backoff retry via withRetry in MatrixClient.
 */

import type { MatrixClient } from './client.js';
import type { SyncEnvelope } from '../../sync/protocol.js';
import type { SyncTransport } from '../../sync/transport.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * EC4: Message deduplication — Matrix doesn't guarantee ordering between
 * homeservers. We use envelope.id for deduplication in SyncManager.
 */
export class MatrixTransport implements SyncTransport {
  private static readonly MAX_SEEN_ENVELOPES = 1000;

  private messageHandlers: Array<(envelope: SyncEnvelope) => void> = [];
  private roomMessageHandler: ((event: { type: string; content: Record<string, unknown>; sender: string }) => void) | null = null;
  private closed = false;
  private reconnecting = false;
  private pollIntervalMs = 1000;
  private readonly seenEnvelopeIds = new Set<string>();
  private readonly seenEnvelopeOrder: string[] = [];

  constructor(
    private readonly matrixClient: MatrixClient,
    private readonly roomId: string,
  ) {}

  /**
   * EC2: Start the sync polling loop with auto-reconnect.
   * Call this after joining a room to begin receiving messages.
   */
  async connect(): Promise<void> {
    if (this.closed) return;
    this.reconnecting = false;
    await this.syncLoop();
  }

  private async syncLoop(): Promise<void> {
    while (!this.closed && !this.reconnecting) {
      try {
        const messages = await this.matrixClient.getMessages(this.roomId, 50);
        for (const msg of messages) {
          this.deliverEnvelope(msg.content, msg.type);
        }

        await sleep(this.pollIntervalMs);
      } catch {
        if (this.closed || this.reconnecting) break;
        // EC2: reconnect after delay
        await sleep(3000);
        // Continue loop to retry
      }
    }
  }

  /**
   * B4: Sends via MatrixClient.sendMessage which has built-in retry.
   */
  async send(envelope: SyncEnvelope): Promise<void> {
    if (this.closed) {
      throw new Error('MatrixTransport is closed');
    }

    // EC4: Include envelope.id for deduplication
    await this.matrixClient.sendMessage(this.roomId, {
      msgtype: 'm.text',
      body: JSON.stringify(envelope),
      // Custom keys for Memphis sync protocol
      'm.type': envelope.type,
      'm.id': envelope.id,
      'm.sender': envelope.senderDid,
    });
  }

  /**
   * Register a handler for incoming sync envelopes.
   * Note: connect() must be called separately to start receiving.
   */
  onMessage(handler: (envelope: SyncEnvelope) => void): void {
    this.messageHandlers.push(handler);

    // B3 fix: only register one room message handler
    if (this.roomMessageHandler) {
      return;
    }

    this.roomMessageHandler = (event) => {
      this.deliverEnvelope(event.content, event.type);
    };
  }

  /**
   * Close the transport and stop the sync loop.
   * EC2: Marks reconnecting=true to break the sync loop.
   */
  close(): void {
    this.closed = true;
    this.reconnecting = true;
    this.messageHandlers = [];
    this.roomMessageHandler = null;
    this.seenEnvelopeIds.clear();
    this.seenEnvelopeOrder.length = 0;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private deliverEnvelope(content: Record<string, unknown>, type: string): void {
    if (type !== 'm.room.message') return;

    const msgType = content['m.type'];
    const declaredEnvelopeId = content['m.id'];
    if (typeof msgType !== 'string' || typeof declaredEnvelopeId !== 'string') {
      return;
    }

    try {
      const envelope = JSON.parse(String(content.body ?? '')) as SyncEnvelope;
      const envelopeId = envelope.id || declaredEnvelopeId;
      if (!envelopeId || this.hasSeenEnvelope(envelopeId)) {
        return;
      }
      this.rememberEnvelope(envelopeId);
      for (const handler of this.messageHandlers) {
        handler(envelope);
      }
    } catch {
      // Ignore malformed Memphis sync messages
    }
  }

  private hasSeenEnvelope(envelopeId: string): boolean {
    return this.seenEnvelopeIds.has(envelopeId);
  }

  private rememberEnvelope(envelopeId: string): void {
    this.seenEnvelopeIds.add(envelopeId);
    this.seenEnvelopeOrder.push(envelopeId);
    if (this.seenEnvelopeOrder.length <= MatrixTransport.MAX_SEEN_ENVELOPES) {
      return;
    }

    const evicted = this.seenEnvelopeOrder.shift();
    if (evicted) {
      this.seenEnvelopeIds.delete(evicted);
    }
  }
}
