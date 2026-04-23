/**
 * Kartograf checkpoint envelope: canonical shape + Ed25519 sign/verify.
 *
 * Every Kartograf checkpoint that ships outside the host machine
 * (HF Hub, GitHub release, federation peer) is wrapped in this envelope
 * so consumers can verify:
 *   1. The ONNX model + tokenizer blobs match their declared sha256
 *      (tamper detection).
 *   2. The envelope itself is signed by a known distributor's DID
 *      (source attribution).
 *
 * Signing uses Ed25519 (node:crypto native, no NAPI needed) over the
 * deterministic JSON canonicalization of the envelope minus the
 * signature field. The signer's public key is encoded in `signer_did`
 * as `did:key:ed25519:<hex>`; verify pulls the key material back out.
 *
 * This is intentionally independent of the chain-block signing path:
 * checkpoints aren't durable memory blocks and shouldn't flow through
 * the chain validator. The spec lives in docs/dev/KARTOGRAF-SPEC.md.
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export type HeadsConfig = {
  /** Embedding head dimension (v1 = 256). */
  embedding_dim: number;
  /** Zone classifier head class count (v1 = 12 per kartograf_spec_frozen). */
  zone_classes: number;
  /** Loss weighting α / (1-α) between InfoNCE and CE. */
  multitask_alpha: number;
};

export type TrainingProvenance = {
  /** ISO-8601 timestamp when training finished. */
  trained_at: string;
  /** Corpus version (e.g. 'v1'). */
  corpus_version: string;
  /** Hardware profile — 'gtx-960-local' | 'h100-cloud' | etc. */
  hardware: string;
  /** Eval metric at checkpoint selection (Recall@10 for v1). */
  eval_recall_at_10: number;
  /** Total training steps. */
  steps: number;
};

export type CheckpointEnvelope = {
  /** Spec version — currently 'kartograf-v1'. */
  version: 'kartograf-v1';
  /** Base model identity (HF revision pinned). */
  base_model: string;
  /** sha256 of the ONNX graph file. */
  onnx_sha256: string;
  /** sha256 of the tokenizer bundle. */
  tokenizer_sha256: string;
  heads_config: HeadsConfig;
  training_provenance: TrainingProvenance;
  /** Distribution trust tier per federation model: 'hf-hub' | 'github-release' | 'file' | 'federation' | 'agora'. */
  distribution_source: 'hf-hub' | 'github-release' | 'file' | 'federation' | 'agora';
  /** `did:key:ed25519:<64-hex>` — signer's DID. */
  signer_did: string;
  /** Ed25519 signature over canonical JSON of everything above. */
  signature: string;
};

export type UnsignedEnvelope = Omit<CheckpointEnvelope, 'signature'>;

const ED25519_DID_PREFIX = 'did:key:ed25519:';

/**
 * Canonical JSON for signing / verification. Keys are sorted
 * recursively so the same logical envelope produces identical bytes
 * on both sides of the wire.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/**
 * Hex-encode a buffer. Matches the `<64-hex>` DID encoding.
 */
function hex(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

/**
 * Wrap raw 32-byte public key material in a PKCS#8-style SPKI DER so
 * node:crypto can import it via createPublicKey. Ed25519 SPKI prefix
 * per RFC 8410.
 */
function ed25519PublicKeyFromHex(keyHex: string) {
  if (keyHex.length !== 64) {
    throw new Error(`expected 32-byte (64-hex) Ed25519 public key, got ${keyHex.length / 2} bytes`);
  }
  const raw = Buffer.from(keyHex, 'hex');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' });
}

function ed25519PrivateKeyFromBytes(seed: Buffer) {
  if (seed.length !== 32) {
    throw new Error(`expected 32-byte Ed25519 seed, got ${seed.length} bytes`);
  }
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/**
 * Sign an unsigned envelope with a 32-byte Ed25519 seed. Returns the
 * completed `CheckpointEnvelope` with `signer_did` stamped from the
 * seed's derived public key and a hex `signature`.
 */
export function signCheckpoint(
  envelope: UnsignedEnvelope,
  seed: Buffer,
): CheckpointEnvelope {
  const privateKey = ed25519PrivateKeyFromBytes(seed);
  // Derive the public key so signer_did is authoritative relative to
  // the secret, not operator-provided metadata that could disagree.
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI is 12 bytes prefix + 32 bytes raw public key.
  const pubHex = hex(rawPub.slice(-32));
  const withDid: UnsignedEnvelope = {
    ...envelope,
    signer_did: `${ED25519_DID_PREFIX}${pubHex}`,
  };
  const bytes = Buffer.from(canonicalize(withDid), 'utf8');
  const sig = sign(null, bytes, privateKey);
  return { ...withDid, signature: hex(sig) };
}

export type VerifyResult =
  | { valid: true; signerDid: string }
  | { valid: false; reason: string };

/**
 * Verify a signed checkpoint envelope. Returns `{ valid: true, signerDid }`
 * on success, `{ valid: false, reason }` otherwise. Never throws — this
 * runs at model-load time where a broken envelope must degrade to
 * "refuse to load" rather than crash the host.
 */
export function verifyCheckpoint(envelope: CheckpointEnvelope): VerifyResult {
  try {
    if (!envelope.signer_did?.startsWith(ED25519_DID_PREFIX)) {
      return { valid: false, reason: 'signer_did missing ed25519 prefix' };
    }
    const pubHex = envelope.signer_did.slice(ED25519_DID_PREFIX.length);
    if (!/^[0-9a-f]{64}$/i.test(pubHex)) {
      return { valid: false, reason: 'signer_did public key not 32-byte hex' };
    }
    if (!envelope.signature || !/^[0-9a-f]+$/i.test(envelope.signature)) {
      return { valid: false, reason: 'signature missing or not hex' };
    }
    const publicKey = ed25519PublicKeyFromHex(pubHex);
    const unsigned: Omit<CheckpointEnvelope, 'signature'> = {
      version: envelope.version,
      base_model: envelope.base_model,
      onnx_sha256: envelope.onnx_sha256,
      tokenizer_sha256: envelope.tokenizer_sha256,
      heads_config: envelope.heads_config,
      training_provenance: envelope.training_provenance,
      distribution_source: envelope.distribution_source,
      signer_did: envelope.signer_did,
    };
    const bytes = Buffer.from(canonicalize(unsigned), 'utf8');
    const ok = verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'hex'));
    if (!ok) return { valid: false, reason: 'signature check failed' };
    return { valid: true, signerDid: envelope.signer_did };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : 'verify-error',
    };
  }
}

/**
 * sha256 helper used by producers to stamp `onnx_sha256` /
 * `tokenizer_sha256` from file contents. Operators can also compute
 * this externally; this is a convenience for in-process signing.
 */
export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
