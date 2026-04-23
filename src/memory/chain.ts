export interface Block {
  index?: number;
  timestamp?: string;
  hash?: string;
  /** Hex-encoded hash of the previous block in the chain (block-level metadata,
   * NOT a payload field). Consumers such as the trajectory exporter rely on
   * this for provenance linkage; prior omission caused every exported event
   * to fall back to `'0'.repeat(64)` which broke hash-chain verification. */
  prev_hash?: string;
  chain?: string;
  data?: {
    content?: string;
    tags?: string[];
    [key: string]: unknown;
  };
  /** Hex-encoded ed25519 public key of the signer. */
  signer?: string;
  /** Hex-encoded ed25519 signature over the canonical block hash. */
  signature?: string;
}
