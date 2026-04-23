import { indexExactSearchBlock } from './exact-search.js';
import type { SurfaceConsent } from '../../gateway/surface-policy.js';
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
   * Consent level stamped on the persisted block. Defaults come from
   * `SurfacePolicy.defaultConsent`; callers pass an explicit value when
   * they know better (e.g. operator CLI writes → 'exportable'; telegram
   * chat writes → 'local-only'). If omitted AND no default from caller,
   * falls back to 'local-only' (privacy-first).
   */
  consent?: SurfaceConsent;
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
  const consent: SurfaceConsent = input.consent ?? 'local-only';
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
