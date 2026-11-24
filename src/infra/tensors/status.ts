import { DEFAULT_TENSOR_SURFACE_POLICY, memoryEmbeddingMeta } from './types.js';
import { getKartografRuntimeSnapshot } from '../../kartograf/runtime.js';
import { resolveEmbedProfile } from '../storage/embed-profile.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';

export interface TensorStatus {
  ok: true;
  surfacePolicy: typeof DEFAULT_TENSOR_SURFACE_POLICY;
  memoryEmbedding: {
    bridge: ReturnType<typeof getRustEmbedAdapterStatus>;
    truthRole: 'derived-recall-index';
    configured: {
      dim: number;
      dtype: 'f32';
      mode: string;
      providerModel?: string;
      persistenceEnabled: boolean;
      persistencePath: string;
      legacyDimMismatch: boolean;
      /**
       * Where the dimension came from: `env`, `index` or
       * `local-deterministic`. The owner's answer — this side does not
       * decide it.
       */
      dimensionSource: string;
      /** The dimension recorded in the index on disk, if it is readable. */
      indexDimension: number | null;
      /** The owner's verdict: `ok`, `no-provider`, `no-index`, `dimension-mismatch`. */
      verdict: string;
      /** What to do about the verdict, in the owner's words. */
      remedy: string | null;    };
    runtime: {
      persistenceEnabled: boolean | 'unknown';
      persistenceLoadState: string | 'unknown';
    };
    meta: ReturnType<typeof memoryEmbeddingMeta>;
  };
  kartograf: {
    enabled: boolean;
    mode: 'onnx' | 'stub' | 'not-loaded';
    runtimeState: ReturnType<typeof getKartografRuntimeSnapshot>['state'];
    embeddingSpace: ReturnType<typeof getKartografRuntimeSnapshot>['embeddingSpace'];
    configuredCheckpointId?: string;
    dim: number;
    dtype: 'f32';
    zoneClasses: number;
    checkpointId?: string;
  };
}

function parseNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function getTensorStatus(rawEnv: NodeJS.ProcessEnv = process.env): TensorStatus {
  const bridge = getRustEmbedAdapterStatus(rawEnv);
  // The embed profile has ONE owner (the Rust crate
  // `crates/memphis-embed/src/profile.rs`). This used to read
  // `RUST_EMBED_DIM` with a hard-coded fallback of 32 — the width of the
  // LOCAL DETERMINISTIC embedder, not an embedding dimension — and to
  // build the index path from HOME, while the runtime reads the data dir.
  // Measured 2026-11-23 on the operator's host: the service answered
  // dim 1024 and a shell answered dim 32 against the same index.
  const profile = resolveEmbedProfile(rawEnv);
  const dim = profile.dimension;
  const mode = profile.mode;
  const persistenceEnabled = parseBool(rawEnv.RUST_EMBED_PERSIST_ENABLED, true);
  const persistencePath = profile.indexPath;
  const provider = profile.providerConfigured ? profile.mode : 'local-deterministic';

  const kartografEnabled = rawEnv.MEMPHIS_KARTOGRAF_ENABLE === '1';
  const kartografDim = parseNumber(rawEnv.MEMPHIS_KARTOGRAF_EMBED_DIM, 256);
  const zoneClasses = parseNumber(rawEnv.MEMPHIS_KARTOGRAF_ZONE_CLASSES, 12);
  const kartograf = getKartografRuntimeSnapshot();

  return {
    ok: true,
    surfacePolicy: DEFAULT_TENSOR_SURFACE_POLICY,
    memoryEmbedding: {
      bridge,
      truthRole: 'derived-recall-index',
      configured: {
        dim,
        dtype: 'f32',
        mode,
        providerModel: profile.model ?? undefined,
        persistenceEnabled,
        persistencePath,
        legacyDimMismatch: profile.dimensionMismatch,
        dimensionSource: profile.dimensionSource,
        indexDimension: profile.indexDimension,
        verdict: profile.verdict,
        remedy: profile.remedy,
      },
      runtime: {
        persistenceEnabled: 'unknown',
        persistenceLoadState: bridge.embedApiAvailable ? 'runtime-dependent' : 'unknown',
      },
      meta: memoryEmbeddingMeta({
        dim,
        provider,
        persistenceEnabled,
        persistenceLoadState: bridge.embedApiAvailable ? 'runtime-dependent' : 'unavailable',
      }),
    },
    kartograf: {
      enabled: kartografEnabled,
      mode: kartograf.state === 'ready' ? 'onnx' : kartografEnabled ? 'not-loaded' : 'stub',
      runtimeState: kartograf.state,
      embeddingSpace: kartograf.embeddingSpace,
      dim: kartograf.embeddingSpace?.dimension ?? kartografDim,
      dtype: 'f32',
      zoneClasses,
      checkpointId: kartograf.checkpointId ?? undefined,
      configuredCheckpointId: rawEnv.MEMPHIS_KARTOGRAF_CHECKPOINT_ID,
    },
  };
}
