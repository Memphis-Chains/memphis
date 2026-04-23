import { indexExactSearchBlock } from './exact-search.js';
import { resolveSurfacePolicy, type SurfaceConsent } from '../../gateway/surface-policy.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';
import { appendBlock } from '../storage/chain-adapter.js';
import { embedStore } from '../storage/rust-embed-adapter.js';

export type DurableMemoryStoreInput = {
  content: string;
  tags?: string[];
  memoryId?: string;
  source?: string;
  chain?: string;
  /**
   * Turn identifier linking this memory block to a conversation turn.
   * Passed from `src/gateway/turn-runtime.ts::generateTurnId()` when the
   * write happens inside a user-initiated turn. `undefined` for
   * scheduled / boot / system-event writes (unlinked events per
   * trajectory v1 schema).
   */
  turnId?: string;
  /**
   * Consent level stamped on the persisted block. Resolution order:
   *   1. Explicit `consent` value (caller knows best).
   *   2. `surface` hint → `resolveSurfacePolicy(surface).defaultConsent`
   *      (honors MEMPHIS_SURFACE_<NAME>_DEFAULT_CONSENT env overrides).
   *   3. Fallback 'exportable' — matches pre-N8 grandfathering where
   *      consent-less legacy blocks are read as exportable per
   *      docs/dev/TRAJECTORY-EXPORT-V1.md consent-handling section.
   * Callers should always pass either `consent` or `surface` for
   * explicit semantics; bare fallback exists only for backward compat.
   */
  consent?: SurfaceConsent;
  /**
   * Surface hint used when `consent` is absent. Resolved via
   * `resolveSurfacePolicy(surface).defaultConsent`, so per-surface env
   * overrides apply uniformly to MCP / CLI / HTTP / telegram writes
   * without each caller re-implementing consent lookup.
   */
  surface?: string;
};

export type DurableMemoryStoreResult = {
  success: boolean;
  memoryId: string;
  index: number;
  hash: string;
  indexed: boolean;
  embed?: { id: string; count: number; dim: number; provider: string };
};

export type DurableMemoryDeps = {
  append: typeof appendBlock;
  index: typeof embedStore;
  indexExact?: typeof indexExactSearchBlock;
};

const defaultDeps: DurableMemoryDeps = {
  append: appendBlock,
  index: embedStore,
  indexExact: indexExactSearchBlock,
};

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter((tag) => tag.trim().length > 0)));
}

/**
 * Resolve the final consent value for a write per the 3-step order
 * documented on `DurableMemoryStoreInput.consent`. Extracted so tests
 * and advanced callers can inspect the exact fallback path.
 */
export function resolveConsent(input: {
  consent?: SurfaceConsent;
  surface?: string;
}): SurfaceConsent {
  if (input.consent) return input.consent;
  if (input.surface) {
    try {
      return resolveSurfacePolicy(input.surface).defaultConsent;
    } catch {
      // Surface resolution is pure in practice; the catch is defensive
      // so a future env-var parsing bug can't break memory writes.
    }
  }
  // Pre-N8 grandfathering: legacy consent-less blocks are read as
  // exportable per trajectory-v1 spec. Preserve that default for callers
  // that pass neither an explicit consent nor a surface hint.
  return 'exportable';
}

export function buildDefaultMemoryId(chain: string, index: number): string {
  return `${chain}-${String(index)}`;
}

export function buildEmbedTags(chain: string, tags?: string[]): string[] {
  return uniqueTags([...(tags ?? []), `chain:${chain}`]);
}

export async function storeDurableMemory(
  input: DurableMemoryStoreInput,
  deps: DurableMemoryDeps = defaultDeps,
): Promise<DurableMemoryStoreResult> {
  const scan = scanContent(input.content, 'memory');
  if (!scan.allowed) {
    await emitRuntimeSecurityEvent({
      action: 'content_scan.durable_memory.blocked',
      status: 'blocked',
      details: {
        patternId: scan.patternId,
        reason: scan.reason,
        profile: scan.profile,
        contentHash: scan.contentHash,
        source: input.source ?? 'memphis',
        chain: input.chain?.trim() || 'journal',
      },
    });
    throw new Error(`Blocked durable memory content: ${scan.reason}`);
  }

  const chain = input.chain?.trim() || 'journal';
  const consent: SurfaceConsent = resolveConsent(input);
  const blockPayload: Record<string, unknown> = {
    content: input.content,
    tags: input.tags ?? [],
    source: input.source ?? 'memphis',
    memory_id: input.memoryId,
    consent,
  };
  // Only stamp turnId when present — unlinked events (scheduled writes,
  // boot-time system events) legitimately have no turn binding.
  if (input.turnId) {
    blockPayload.turn_id = input.turnId;
  }
  const block = await deps.append(chain, blockPayload);

  const memoryId = input.memoryId?.trim() || buildDefaultMemoryId(chain, block.index);
  const embedTags = buildEmbedTags(chain, input.tags);

  try {
    deps.indexExact?.(
      {
        chain,
        index: block.index,
        hash: block.hash,
        data: {
          content: input.content,
          tags: input.tags ?? [],
          source: input.source ?? 'memphis',
          memory_id: memoryId,
        },
      },
      process.env,
    );
  } catch {
    // Exact search is derived state and can be rebuilt from durable blocks.
  }

  try {
    const embed = deps.index(memoryId, input.content, undefined, embedTags);
    return {
      success: true,
      memoryId,
      index: block.index,
      hash: block.hash,
      indexed: true,
      embed,
    };
  } catch {
    return {
      success: true,
      memoryId,
      index: block.index,
      hash: block.hash,
      indexed: false,
    };
  }
}
