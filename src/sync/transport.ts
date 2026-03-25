import type { SyncEnvelope } from './protocol.js';

/**
 * Transport abstraction for sync protocol.
 * Allows swapping between WebSocket (direct P2P) and Matrix (federated room-based).
 */
export interface SyncTransport {
  /**
   * Send an envelope through the transport.
   * @throws Error if the transport is not ready or send fails.
   */
  send(envelope: SyncEnvelope): Promise<void>;

  /**
   * Register a handler for incoming envelopes.
   * The handler is called for each envelope received on this transport.
   */
  onMessage(handler: (envelope: SyncEnvelope) => void): void;

  /**
   * Close the transport and release all resources.
   * After close(), the transport cannot be reused.
   */
  close(): void;
}
