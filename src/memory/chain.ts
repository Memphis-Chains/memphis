export interface Block {
  index?: number;
  timestamp?: string;
  hash?: string;
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
