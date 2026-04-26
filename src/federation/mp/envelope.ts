/**
 * MP v0 — signed message envelope between Memphis peers.
 *
 * Sits between the Matrix transport and the chain audit. Every outbound
 * SyncEnvelope is canonically serialized, signed with the operator's
 * Ed25519 vault seed, and stamped with the operator's `did:memphis:z...`
 * DID. Every inbound envelope is verified against the claimed signer DID
 * before the wrapper transport delivers it to handlers.
 *
 * DID format is `did:memphis:z<multibase58btc(0xed01 || pubkey32)>` —
 * canonical for the vault (crates/memphis-vault/src/did.rs:81-85). We
 * deliberately do NOT support `did:key:ed25519:<hex>` here — that's the
 * Kartograf checkpoint format. MP v0 commits to one DID format end to end
 * to avoid silent format drift between layers.
 *
 * Crypto runs in-process via node:crypto Ed25519 — no NAPI bridge, no
 * Rust roundtrip. Mirrors the proven pattern in src/kartograf/checkpoint.ts.
 *
 * `verifyEnvelope` returns a discriminated union — never throws. Verify
 * sits on the federation receive hot path; an exception there closes the
 * room loop.
 */

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import type { SyncEnvelope } from '../../sync/protocol.js';

const DID_MEMPHIS_PREFIX = 'did:memphis:z';
const ED25519_MULTICODEC = Buffer.from([0xed, 0x01]);

export type SignedSyncEnvelope<TPayload = unknown> = SyncEnvelope<TPayload> & {
  signerDid: string;
  signature: string;
};

export type VerifyEnvelopeFailureReason =
  | 'unsigned_rejected'
  | 'signature_invalid'
  | 'signer_did_invalid'
  | 'sender_signer_mismatch'
  | 'canonicalization_error';

export type VerifyEnvelopeResult =
  | { valid: true; signerDid: string; envelope: SignedSyncEnvelope }
  | { valid: false; reason: VerifyEnvelopeFailureReason; signerDid: string | null };

/**
 * Recursive sorted-keys JSON serialization — deterministic across runs
 * regardless of insertion order or platform Object iteration.
 *
 * Mirrors src/kartograf/checkpoint.ts:80-89. Duplicated here rather than
 * imported to keep federation/mp independent of kartograf — these two
 * subsystems should not reach across each other for tiny utilities.
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

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = (() => {
  const idx: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i += 1) idx[BASE58_ALPHABET[i]] = i;
  return idx;
})();

function base58btcEncode(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros += 1;
  // Convert byte array to a base-58 representation via repeated division.
  const digits: number[] = [0];
  for (let i = leadingZeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (let i = 0; i < leadingZeros; i += 1) out += BASE58_ALPHABET[0];
  for (let i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET[digits[i]];
  return out;
}

function base58btcDecode(text: string): Buffer | null {
  if (text.length === 0) return Buffer.alloc(0);
  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === BASE58_ALPHABET[0]) {
    leadingZeros += 1;
  }
  const bytes: number[] = [0];
  for (let i = leadingZeros; i < text.length; i += 1) {
    const ch = text[i];
    const value = BASE58_INDEX[ch];
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(leadingZeros + bytes.length);
  for (let i = bytes.length - 1, k = leadingZeros; i >= 0; i -= 1, k += 1) out[k] = bytes[i];
  return out;
}

/**
 * `did:memphis:z<base58btc(0xed01 || pubkey32)>` -> raw 32-byte pubkey.
 * Returns null on any format error so callers handle this as data, not
 * exception flow.
 */
export function pubkeyFromDidMemphis(did: string): Buffer | null {
  if (typeof did !== 'string' || !did.startsWith(DID_MEMPHIS_PREFIX)) return null;
  const b58 = did.slice(DID_MEMPHIS_PREFIX.length);
  const decoded = base58btcDecode(b58);
  if (!decoded || decoded.length !== 34) return null;
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) return null;
  return decoded.subarray(2, 34);
}

/** Inverse — used to stamp signerDid from a freshly derived pubkey. */
export function didMemphisFromPubkey(pubkey: Buffer): string {
  if (pubkey.length !== 32) {
    throw new Error(`expected 32-byte ed25519 pubkey, got ${pubkey.length} bytes`);
  }
  const payload = Buffer.concat([ED25519_MULTICODEC, pubkey]);
  return `${DID_MEMPHIS_PREFIX}${base58btcEncode(payload)}`;
}

/**
 * Wrap a 32-byte raw public key in a PKCS-style SPKI DER so node:crypto
 * can import it via createPublicKey. Ed25519 SPKI prefix per RFC 8410.
 */
function ed25519PublicKeyFromBytes(pubkey: Buffer) {
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, pubkey]), format: 'der', type: 'spki' });
}

function ed25519PrivateKeyFromBytes(seed: Buffer) {
  if (seed.length !== 32) {
    throw new Error(`expected 32-byte ed25519 seed, got ${seed.length} bytes`);
  }
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([pkcs8Prefix, seed]), format: 'der', type: 'pkcs8' });
}

function pubkeyFromSeed(seed: Buffer): Buffer {
  const priv = ed25519PrivateKeyFromBytes(seed);
  const pub = createPublicKey(priv);
  const der = pub.export({ format: 'der', type: 'spki' });
  // SPKI = 12 bytes prefix + 32 bytes raw key.
  return Buffer.from(der.subarray(der.length - 32));
}

/**
 * Canonical bytes that get signed. `signature` is omitted by construction;
 * everything else (including signerDid) is in the signed body.
 */
export function canonicalizeEnvelope(env: Omit<SignedSyncEnvelope, 'signature'>): string {
  return canonicalize(env);
}

/**
 * Sign a SyncEnvelope. Strips any incoming `signature` / `signerDid` so a
 * caller cannot smuggle in a mismatched DID. The signer DID is ALWAYS
 * derived from the seed so it's authoritative against the secret.
 *
 * The caller is responsible for setting `senderDid` on the envelope. We
 * then assert `senderDid === signerDid` on outbound to surface bugs at
 * sign time rather than at the peer's verify path.
 */
export function signEnvelope<TPayload>(
  envelope: SyncEnvelope<TPayload>,
  seed: Buffer,
): SignedSyncEnvelope<TPayload> {
  const privateKey = ed25519PrivateKeyFromBytes(seed);
  const pubkey = pubkeyFromSeed(seed);
  const signerDid = didMemphisFromPubkey(pubkey);

  if (envelope.senderDid && envelope.senderDid !== signerDid) {
    throw new Error(
      `signEnvelope: senderDid (${envelope.senderDid}) does not match seed-derived DID (${signerDid})`,
    );
  }

  // Strip any pre-existing sig fields and overwrite signerDid with the
  // authoritative one. Defensive normalization of the payload guards
  // against non-JSON-stringifiable values (BigInt, Date) — round-trip
  // through JSON so canonicalize sees only stable shapes.
  const normalizedPayload = JSON.parse(
    JSON.stringify(envelope.payload ?? null),
  ) as TPayload;

  const unsigned: Omit<SignedSyncEnvelope<TPayload>, 'signature'> = {
    id: envelope.id,
    type: envelope.type,
    senderDid: signerDid,
    targetDid: envelope.targetDid,
    ts: envelope.ts,
    payload: normalizedPayload,
    signerDid,
  };

  const bytes = Buffer.from(canonicalizeEnvelope(unsigned), 'utf8');
  const sig = sign(null, bytes, privateKey);
  return { ...unsigned, signature: sig.toString('hex') };
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0;
}

/**
 * Verify a candidate envelope. Never throws; returns a tagged union so
 * callers can branch cleanly on `valid`. Does NOT consult any peer trust
 * store — that's the wrapper transport's job. We only check that the
 * signature math is sound and the envelope is internally consistent.
 */
export function verifyEnvelope(candidate: unknown): VerifyEnvelopeResult {
  try {
    if (!candidate || typeof candidate !== 'object') {
      return { valid: false, reason: 'canonicalization_error', signerDid: null };
    }
    const env = candidate as Partial<SignedSyncEnvelope>;

    if (typeof env.signature !== 'string' || env.signature.length === 0) {
      return { valid: false, reason: 'unsigned_rejected', signerDid: null };
    }
    if (typeof env.signerDid !== 'string' || env.signerDid.length === 0) {
      return { valid: false, reason: 'unsigned_rejected', signerDid: null };
    }
    if (!isHex(env.signature)) {
      return { valid: false, reason: 'signature_invalid', signerDid: env.signerDid };
    }

    const pubkey = pubkeyFromDidMemphis(env.signerDid);
    if (!pubkey) {
      return { valid: false, reason: 'signer_did_invalid', signerDid: env.signerDid };
    }

    if (typeof env.senderDid !== 'string' || env.senderDid !== env.signerDid) {
      return { valid: false, reason: 'sender_signer_mismatch', signerDid: env.signerDid };
    }

    if (
      typeof env.id !== 'string' ||
      typeof env.type !== 'string' ||
      typeof env.ts !== 'string'
    ) {
      return { valid: false, reason: 'canonicalization_error', signerDid: env.signerDid };
    }

    const unsigned: Omit<SignedSyncEnvelope, 'signature'> = {
      id: env.id,
      type: env.type as SyncEnvelope['type'],
      senderDid: env.senderDid,
      targetDid: env.targetDid,
      ts: env.ts,
      payload: env.payload as unknown,
      signerDid: env.signerDid,
    };

    const bytes = Buffer.from(canonicalizeEnvelope(unsigned), 'utf8');
    const publicKey = ed25519PublicKeyFromBytes(pubkey);
    const sigBytes = Buffer.from(env.signature, 'hex');
    const ok = verify(null, bytes, publicKey, sigBytes);
    if (!ok) return { valid: false, reason: 'signature_invalid', signerDid: env.signerDid };

    return {
      valid: true,
      signerDid: env.signerDid,
      envelope: { ...unsigned, signature: env.signature } satisfies SignedSyncEnvelope,
    };
  } catch {
    return { valid: false, reason: 'canonicalization_error', signerDid: null };
  }
}

export const __testing = {
  base58btcEncode,
  base58btcDecode,
  pubkeyFromSeed,
};
