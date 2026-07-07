import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_TENSOR_SURFACE_POLICY, memoryEmbeddingMeta } from './types.js';
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
    };
    runtime: {
      persistenceEnabled: boolean | 'unknown';
      persistenceLoadState: string | 'unknown';
    };
    meta: ReturnType<typeof memoryEmbeddingMeta>;
  };
  kartograf: {
    enabled: boolean;
    mode: 'onnx' | 'stub';
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

function defaultEmbedPath(rawEnv: NodeJS.ProcessEnv): string {
  return join(rawEnv.HOME ?? '.', '.memphis', 'embed', 'index-v1.json');
}

function readLegacyDimMismatch(path: string, configuredDim: number): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dim?: unknown };
    return typeof parsed.dim === 'number' && parsed.dim !== configuredDim;
  } catch {
    return false;
  }
}

export function getTensorStatus(rawEnv: NodeJS.ProcessEnv = process.env): TensorStatus {
  const bridge = getRustEmbedAdapterStatus(rawEnv);
  const dim = parseNumber(rawEnv.RUST_EMBED_DIM, 32);
  const mode = rawEnv.RUST_EMBED_MODE?.trim() || 'local';
  const persistenceEnabled = parseBool(rawEnv.RUST_EMBED_PERSIST_ENABLED, true);
  const persistencePath = rawEnv.RUST_EMBED_PERSIST_PATH?.trim() || defaultEmbedPath(rawEnv);
  const provider = mode === 'local' ? 'local-deterministic' : mode;

  const kartografEnabled = rawEnv.MEMPHIS_KARTOGRAF_ENABLE === '1';
  const kartografDim = parseNumber(rawEnv.MEMPHIS_KARTOGRAF_EMBED_DIM, 256);
  const zoneClasses = parseNumber(rawEnv.MEMPHIS_KARTOGRAF_ZONE_CLASSES, 12);

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
        providerModel: rawEnv.RUST_EMBED_PROVIDER_MODEL,
        persistenceEnabled,
        persistencePath,
        legacyDimMismatch: readLegacyDimMismatch(persistencePath, dim),
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
      mode: kartografEnabled ? 'onnx' : 'stub',
      dim: kartografDim,
      dtype: 'f32',
      zoneClasses,
      checkpointId: rawEnv.MEMPHIS_KARTOGRAF_CHECKPOINT_ID,
    },
  };
}
