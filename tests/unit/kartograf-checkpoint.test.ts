import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  signCheckpoint,
  verifyCheckpoint,
  type CheckpointEnvelope,
  type UnsignedEnvelope,
} from '../../src/kartograf/checkpoint.js';

function baseUnsigned(): Omit<UnsignedEnvelope, 'signer_did'> & { signer_did?: string } {
  return {
    version: 'kartograf-v1',
    base_model: 'answerdotai/ModernBERT-base@rev-abc123',
    onnx_sha256: 'a'.repeat(64),
    tokenizer_sha256: 'b'.repeat(64),
    heads_config: {
      embedding_dim: 256,
      zone_classes: 12,
      multitask_alpha: 0.7,
    },
    training_provenance: {
      trained_at: '2026-05-15T10:00:00Z',
      corpus_version: 'v1',
      hardware: 'gtx-960-local',
      eval_recall_at_10: 0.82,
      steps: 12000,
    },
    distribution_source: 'hf-hub',
  };
}

describe('kartograf checkpoint envelope', () => {
  it('canonicalize sorts keys deterministically', () => {
    const a = canonicalize({ b: 2, a: 1, c: [3, { y: 2, x: 1 }] });
    const b = canonicalize({ c: [3, { x: 1, y: 2 }], a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('signs and round-trip verifies with the derived DID', () => {
    const seed = randomBytes(32);
    const unsigned = baseUnsigned() as UnsignedEnvelope;
    const signed = signCheckpoint(unsigned, seed);
    expect(signed.signer_did).toMatch(/^did:key:ed25519:[0-9a-f]{64}$/);
    expect(signed.signature).toMatch(/^[0-9a-f]+$/);
    const result = verifyCheckpoint(signed);
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered envelope', () => {
    const seed = randomBytes(32);
    const signed = signCheckpoint(baseUnsigned() as UnsignedEnvelope, seed);
    const tampered: CheckpointEnvelope = { ...signed, onnx_sha256: 'c'.repeat(64) };
    const result = verifyCheckpoint(tampered);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/signature/);
  });

  it('rejects malformed signer_did', () => {
    const seed = randomBytes(32);
    const signed = signCheckpoint(baseUnsigned() as UnsignedEnvelope, seed);
    const broken: CheckpointEnvelope = { ...signed, signer_did: 'did:key:rsa:xyz' };
    const result = verifyCheckpoint(broken);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/ed25519 prefix/);
  });

  it('rejects non-hex signature', () => {
    const seed = randomBytes(32);
    const signed = signCheckpoint(baseUnsigned() as UnsignedEnvelope, seed);
    const broken: CheckpointEnvelope = { ...signed, signature: 'not-hex-yo' };
    const result = verifyCheckpoint(broken);
    expect(result.valid).toBe(false);
  });

  it('stamps signer_did derived from the actual seed', () => {
    const seedA = randomBytes(32);
    const seedB = randomBytes(32);
    const aSigned = signCheckpoint(baseUnsigned() as UnsignedEnvelope, seedA);
    const bSigned = signCheckpoint(baseUnsigned() as UnsignedEnvelope, seedB);
    expect(aSigned.signer_did).not.toBe(bSigned.signer_did);
    // Verify with the other signer's key fails.
    const crossed: CheckpointEnvelope = { ...aSigned, signer_did: bSigned.signer_did };
    expect(verifyCheckpoint(crossed).valid).toBe(false);
  });
});
