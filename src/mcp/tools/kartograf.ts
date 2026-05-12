/**
 * memphis_kartograf — first-class tool wrapping the runtime singleton.
 *
 * Daemon callers (cognitive frames, cron triggers) reach for this when
 * they want a zone-routing hint plus a 256-d embedding. The runtime is
 * lazy-loaded the first time anyone asks; subsequent calls share the
 * singleton (no 700-MB reload).
 *
 * Returns a structured error rather than zero vectors when the runtime
 * is disabled or the checkpoint is broken — silent degradation here
 * would propagate as misrouted writes, exactly what the spec calls out
 * as "P0 routing failure" in docs/dev/KARTOGRAF-SPEC.md.
 */
import { getKartografRuntime } from '../../kartograf/runtime.js';
import type { ZoneClassification } from '../../kartograf/session.js';

export interface MemphisKartografInput {
  query: string;
  top_k_zones?: number;
}

export type MemphisKartografOutput =
  | {
      ok: true;
      query: string;
      checkpointId: string;
      embeddingDim: number;
      embeddingPreview: number[];
      zones: ZoneClassification[];
      elapsedMs: number;
    }
  | {
      ok: false;
      error: string;
      hint?: string;
      stateKind: 'disabled' | 'no-checkpoint' | 'load-failed';
    };

export async function runMemphisKartograf(
  input: MemphisKartografInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<MemphisKartografOutput> {
  const query = input.query?.toString().trim();
  if (!query) {
    return {
      ok: false,
      error: 'memphis_kartograf requires non-empty query',
      stateKind: 'disabled',
    };
  }

  const runtime = await getKartografRuntime(rawEnv);
  if (runtime.kind !== 'ready') {
    return {
      ok: false,
      error: runtime.reason,
      stateKind: runtime.kind,
      hint:
        runtime.kind === 'disabled'
          ? 'Set MEMPHIS_KARTOGRAF_ENABLE=1 in .env and restart the daemon'
          : runtime.kind === 'no-checkpoint'
            ? 'Run `memphis kartograf install --file <envelope>.json --source file` first'
            : 'Check daemon stderr for the ONNX load error; the most common cause is an ABI mismatch between onnxruntime-node versions',
    };
  }

  const session = runtime.session;
  const topK = input.top_k_zones;

  const t0 = Date.now();
  const result = await session.embed(query);
  const elapsedMs = Date.now() - t0;

  const zones = typeof topK === 'number' && topK > 0 ? result.zones.slice(0, topK) : result.zones;

  return {
    ok: true,
    query,
    checkpointId: result.checkpointId,
    embeddingDim: result.embedding.length,
    // Surface only the first 8 dims to keep tool output token-cheap.
    // Consumers needing the full vector should call the underlying
    // KartografSession directly (intentionally not exposed as a tool —
    // 256 floats × 4 bytes × N tools-per-frame would balloon prompt
    // size with no actionable value for the LLM).
    embeddingPreview: Array.from(result.embedding.slice(0, 8)),
    zones,
    elapsedMs,
  };
}
