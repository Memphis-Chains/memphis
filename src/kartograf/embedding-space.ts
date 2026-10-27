import { canonicalize, sha256Hex, type CheckpointEnvelope } from './checkpoint.js';
import type { KartografOutput, KartografSession } from './session.js';
import { KARTOGRAF_V1_ZONE_LABELS } from './zone-labels.js';

/** Bump the policy if tokenization/preprocessing or output transforms change. */
export const KARTOGRAF_TOKENIZER_POLICY = 'verified-json-no-padding-truncate512-v1';
export const KARTOGRAF_MAX_TOKENS = 512;
export const KARTOGRAF_TOKENIZER_CONFIG = Object.freeze({
  model_max_length: KARTOGRAF_MAX_TOKENS,
  padding_side: 'right',
  clean_up_tokenization_spaces: false,
});

export interface KartografEmbeddingSpace {
  readonly schemaVersion: 1;
  readonly provider: 'kartograf';
  readonly modelSha256: string;
  readonly tokenizerSha256: string;
  readonly dimension: number;
  readonly dtype: 'f32';
  readonly tokenizerPolicy: typeof KARTOGRAF_TOKENIZER_POLICY;
  readonly outputTransform: 'model-output';
  readonly id: string;
}

/** Artifact identity, not a release signature or a dimension-only index key. */
export function embeddingSpaceFor(envelope: CheckpointEnvelope): KartografEmbeddingSpace {
  const dimension = envelope.heads_config.embedding_dim;
  if (
    envelope.version !== 'kartograf-v1' ||
    !Number.isSafeInteger(dimension) ||
    dimension < 1 ||
    dimension > 65536 ||
    ![envelope.onnx_sha256, envelope.tokenizer_sha256].every((v) => /^[a-f0-9]{64}$/.test(v))
  )
    throw new Error('Invalid embedding space metadata');
  const body = {
    schemaVersion: 1 as const,
    provider: 'kartograf' as const,
    modelSha256: envelope.onnx_sha256,
    tokenizerSha256: envelope.tokenizer_sha256,
    dimension,
    dtype: 'f32' as const,
    tokenizerPolicy: KARTOGRAF_TOKENIZER_POLICY,
    outputTransform: 'model-output' as const,
  } as const;
  return Object.freeze({ ...body, id: `kartograf:${sha256Hex(canonicalize(body))}` });
}

export function assertSessionSpace(
  session: KartografSession,
  expected: KartografEmbeddingSpace,
): void {
  if (
    session.checkpointId !== expected.modelSha256 ||
    session.headsConfig.embedding_dim !== expected.dimension ||
    session.embeddingSpace?.id !== expected.id
  )
    throw new Error('Session embedding space does not match the verified checkpoint');
}

/** Apply at each consumer boundary, including sessions substituted by adapters. */
export function assertKartografOutput(
  output: KartografOutput,
  expected: KartografEmbeddingSpace,
): void {
  if (
    output.checkpointId !== expected.modelSha256 ||
    output.embeddingSpaceId !== expected.id ||
    !(output.embedding instanceof Float32Array) ||
    output.embedding.length !== expected.dimension ||
    !output.embedding.every(Number.isFinite) ||
    !output.embedding.some((value) => value !== 0) ||
    !Array.isArray(output.zones) ||
    !output.zones.length ||
    !output.zones.every(
      (z) =>
        KARTOGRAF_V1_ZONE_LABELS.includes(z.zone) &&
        Number.isFinite(z.score) &&
        z.score >= 0 &&
        z.score <= 1,
    ) ||
    new Set(output.zones.map((z) => z.zone)).size !== output.zones.length ||
    output.zones.reduce((sum, z) => sum + z.score, 0) > 1.00001 ||
    output.zones.reduce((sum, z) => sum + z.score, 0) <= 0 ||
    output.zones.some((z, i) => i > 0 && output.zones[i - 1].score < z.score)
  )
    throw new Error('invalid inference output for the verified embedding space');
}
