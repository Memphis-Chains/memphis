import { expect, it } from 'vitest';

import {
  assertKartografOutput,
  assertSessionSpace,
  embeddingSpaceFor,
} from '../../src/kartograf/embedding-space.js';
import { kartografBundleFixture } from '../helpers/kartograf-bundle.js';

it('keys geometry by model, tokenizer and preprocessing instead of release signing metadata', () => {
  const { envelope } = kartografBundleFixture();
  const space = embeddingSpaceFor(envelope);
  expect(Object.isFrozen(space)).toBe(true);
  expect(
    embeddingSpaceFor({
      ...envelope,
      signer_did: 'different-release',
      signature: 'different',
      training_provenance: { ...envelope.training_provenance, trained_at: '2027-01-01T00:00:00Z' },
    }).id,
  ).toBe(space.id);
  expect(embeddingSpaceFor({ ...envelope, tokenizer_sha256: 'b'.repeat(64) }).id).not.toBe(
    space.id,
  );
  expect(embeddingSpaceFor({ ...envelope, onnx_sha256: 'c'.repeat(64) }).id).not.toBe(space.id);
  expect(
    embeddingSpaceFor({ ...envelope, heads_config: { ...envelope.heads_config, embedding_dim: 3 } })
      .id,
  ).not.toBe(space.id);
});

it('refuses same-dimension vectors from another tokenizer/model space, missing identity and invalid values', () => {
  const { envelope } = kartografBundleFixture();
  const space = embeddingSpaceFor(envelope);
  const output = {
    checkpointId: envelope.onnx_sha256,
    embeddingSpaceId: space.id,
    embedding: new Float32Array([0.6, 0.8]),
    zones: [{ zone: 'journal', score: 0.8 }],
  };
  expect(() => assertKartografOutput(output, space)).not.toThrow();
  for (const changed of [
    {
      ...output,
      embeddingSpaceId: embeddingSpaceFor({ ...envelope, tokenizer_sha256: 'b'.repeat(64) }).id,
    },
    { ...output, embeddingSpaceId: undefined },
    { ...output, checkpointId: 'a'.repeat(64) },
    { ...output, embedding: new Float32Array([0, 0]) },
    { ...output, embedding: new Float32Array([1, Number.POSITIVE_INFINITY]) },
    { ...output, zones: [{ zone: 'invented-zone', score: 1 }] },
    { ...output, zones: [{ zone: 'journal', score: 0 }] },
  ])
    expect(() => assertKartografOutput(changed, space)).toThrow();
  expect(() =>
    assertSessionSpace(
      {
        checkpointId: envelope.onnx_sha256,
        headsConfig: envelope.heads_config,
        embeddingSpace: embeddingSpaceFor({ ...envelope, tokenizer_sha256: 'b'.repeat(64) }),
      } as never,
      space,
    ),
  ).toThrow('embedding space');
});
