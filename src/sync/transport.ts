import type { SyncEnvelope } from './protocol.js';

/**
 * Transport abstraction for sync protocol.
 * Allows swapping between WebSocket (direct P2P) and Matrix (federated room-based).
 */
export interface SyncTransport {
  /**
   * Establish the transport connection and begin receiving messages.
   * EC2: Implementations should handle reconnection automatically.
   * No-op if already connected or if transport is lazy (e.g. WebSocket on first send).
   */
  connect?(): Promise<void>;

  /**
   * Send an envelope through the transport.
   * B4: Should retry with exponential backoff on network errors / 5xx / 429.
   * @throws Error if the transport is not ready or send fails after retries.
   */
  send(envelope: SyncEnvelope): Promise<void>;

  /**
   * Register a handler for incoming envelopes.
   * The handler is called for each envelope received on this transport.
   */
  onMessage(handler: (envelope: SyncEnvelope) => void): void;

  /**
   * Close the transport and release all resources.
   * EC2: After close(), the transport cannot be reused.
   */
  close(): void;
}
