import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  canonicalizeEnvelope,
  didMemphisFromPubkey,
  pubkeyFromDidMemphis,
  signEnvelope,
  verifyEnvelope,
  __testing,
  type SignedSyncEnvelope,
} from '../../src/federation/mp/envelope.js';
import type { SyncEnvelope } from '../../src/sync/protocol.js';

function freshSeedAndDid(): { seed: Buffer; did: string } {
  const seed = randomBytes(32);
  const pub = __testing.pubkeyFromSeed(seed);
  return { seed, did: didMemphisFromPubkey(pub) };
}

function baseEnvelope(senderDid: string, payload: unknown = { ok: true }): SyncEnvelope {
  return {
    id: 'env-001',
    type: 'sync.status',
    senderDid,
    ts: '2026-04-25T22:00:00.000Z',
    payload,
  };
}

describe('mp envelope: did:memphis encoding', () => {
  it('round-trips pubkey ↔ did:memphis:z…', () => {
    const seed = randomBytes(32);
    const pub = __testing.pubkeyFromSeed(seed);
    const did = didMemphisFromPubkey(pub);
    expect(did.startsWith('did:memphis:z')).toBe(true);
    const recovered = pubkeyFromDidMemphis(did);
    expect(recovered).not.toBeNull();
    expect(recovered!.equals(pub)).toBe(true);
  });

  it('rejects malformed dids', () => {
    expect(pubkeyFromDidMemphis('did:key:ed25519:abc')).toBeNull();
    expect(pubkeyFromDidMemphis('did:memphis:zNOT-BASE58!!')).toBeNull();
    expect(pubkeyFromDidMemphis('did:memphis:zABC')).toBeNull(); // too short
  });
});

describe('mp envelope: sign / verify round-trip', () => {
  it('signs and verifies cleanly', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    expect(signed.signerDid).toBe(did);
    expect(signed.senderDid).toBe(did);
    expect(signed.signature).toMatch(/^[0-9a-f]+$/);

    const result = verifyEnvelope(signed);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.signerDid).toBe(did);
  });

  it('overwrites a mismatched senderDid with the seed-derived DID', () => {
    const { seed, did } = freshSeedAndDid();
    const env: SyncEnvelope = baseEnvelope('');
    const signed = signEnvelope(env, seed);
    expect(signed.senderDid).toBe(did);
    expect(verifyEnvelope(signed).valid).toBe(true);
  });

  it('throws when caller-provided senderDid contradicts seed', () => {
    const { seed } = freshSeedAndDid();
    const other = freshSeedAndDid();
    const env = baseEnvelope(other.did);
    expect(() => signEnvelope(env, seed)).toThrow(/senderDid/);
  });
});

describe('mp envelope: tampering detection', () => {
  it('flips a payload byte → signature_invalid', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did, { value: 1 }), seed);
    const tampered: SignedSyncEnvelope = {
      ...signed,
      payload: { value: 2 },
    };
    const result = verifyEnvelope(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature_invalid');
  });

  it('rejects sender_signer_mismatch when senderDid is hand-edited', () => {
    const { seed, did } = freshSeedAndDid();
    const other = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    const muted: SignedSyncEnvelope = { ...signed, senderDid: other.did };
    const result = verifyEnvelope(muted);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('sender_signer_mismatch');
  });

  it('rejects malformed signer_did', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    const muted: SignedSyncEnvelope = {
      ...signed,
      senderDid: 'did:bogus:xyz',
      signerDid: 'did:bogus:xyz',
    };
    const result = verifyEnvelope(muted);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signer_did_invalid');
  });

  it('rejects when signature field is missing', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    const { signature: _omit, ...unsigned } = signed;
    void _omit;
    const result = verifyEnvelope(unsigned);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('unsigned_rejected');
  });

  it('rejects when signature is not hex', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    const muted: SignedSyncEnvelope = { ...signed, signature: 'not-hex-!!!' };
    const result = verifyEnvelope(muted);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe('signature_invalid');
  });
});

describe('mp envelope: canonicalization determinism', () => {
  it('produces identical bytes regardless of key insertion order', () => {
    const a = canonicalize({ a: 1, b: { x: 1, y: 2 }, c: [3, 2, 1] });
    const b = canonicalize({ c: [3, 2, 1], b: { y: 2, x: 1 }, a: 1 });
    expect(a).toBe(b);
  });

  it('signs identically when the unsigned envelope is keyed in different order', () => {
    const { seed, did } = freshSeedAndDid();
    const env1 = baseEnvelope(did, { x: 1, y: 2 });
    const env2: SyncEnvelope = {
      type: 'sync.status',
      payload: { y: 2, x: 1 },
      ts: '2026-04-25T22:00:00.000Z',
      id: 'env-001',
      senderDid: did,
    };
    const s1 = signEnvelope(env1, seed);
    const s2 = signEnvelope(env2, seed);
    expect(s1.signature).toBe(s2.signature);
  });

  it('canonicalizeEnvelope omits the signature field by construction', () => {
    const { seed, did } = freshSeedAndDid();
    const signed = signEnvelope(baseEnvelope(did), seed);
    const { signature: _sig, ...unsigned } = signed;
    void _sig;
    const bytes = canonicalizeEnvelope(unsigned);
    expect(bytes.includes(signed.signature)).toBe(false);
    expect(bytes.includes(signed.signerDid)).toBe(true);
  });
});
