export type TensorDType = 'f32';

export type TensorKind = 'memory_embedding' | 'kartograf_embedding' | 'onnx_tensor';

export interface EmbeddingVectorMeta {
  kind: TensorKind;
  dim: number;
  dtype: TensorDType;
  provider: string;
  normalized: boolean | 'provider-dependent';
  exposeRawValues: false;
  persistenceEnabled?: boolean;
  persistenceLoadState?: string;
  checkpointId?: string;
}

export interface TensorSurfacePolicy {
  exposeRawValues: false;
  reason: string;
}

export const DEFAULT_TENSOR_SURFACE_POLICY: TensorSurfacePolicy = {
  exposeRawValues: false,
  reason: 'Memphis public/operator surfaces expose tensor metadata and scores, not raw vectors.',
};

export function memoryEmbeddingMeta(input: {
  dim: number;
  provider: string;
  /**
   * The wire's own word, when this meta comes from a bridge payload.
   *
   * The rule "a local-deterministic provider normalizes" belongs to the
   * Rust core (`embed_normalized_to_str`) — and the payload carries the
   * answer as a word. When the word is here, it IS the answer; the
   * provider-name rule below is only the fallback for the paths that
   * describe an embedding without asking the bridge (the profile path in
   * `tensors/status.ts`).
   */
  normalized?: boolean | 'provider-dependent';
  persistenceEnabled?: boolean;
  persistenceLoadState?: string;
}): EmbeddingVectorMeta {
  return {
    kind: 'memory_embedding',
    dim: input.dim,
    dtype: 'f32',
    provider: input.provider,
    normalized:
      input.normalized ??
      (input.provider === 'local-deterministic' ? true : 'provider-dependent'),
    exposeRawValues: false,
    persistenceEnabled: input.persistenceEnabled,
    persistenceLoadState: input.persistenceLoadState,
  };
}
