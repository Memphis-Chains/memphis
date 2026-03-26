import type { IStore } from './store.js';
import { indexExactSearchBlock } from '../infra/memory/exact-search.js';

export const SUPPORTED_DURABLE_BLOCK_TYPES = [
  'insight',
  'decision',
  'system_event',
  'journal',
  'error',
  'case',
] as const;

export type SupportedDurableBlockType = (typeof SUPPORTED_DURABLE_BLOCK_TYPES)[number];

const SUPPORTED_DURABLE_BLOCK_TYPES_SET = new Set<string>(SUPPORTED_DURABLE_BLOCK_TYPES);

export interface DurableBlockPayload extends Record<string, unknown> {
  type: SupportedDurableBlockType;
  content: string;
  tags: string[];
}

export function createDurableBlockPayload(input: {
  type: SupportedDurableBlockType;
  content: string;
  tags?: unknown[];
  metadata?: Record<string, unknown>;
}): DurableBlockPayload {
  const content = input.content.trim();
  if (!content) {
    throw new Error('Durable block payload requires non-empty content');
  }

  const tags = Array.isArray(input.tags)
    ? input.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  return {
    type: input.type,
    content,
    tags,
    ...(input.metadata ?? {}),
  };
}

export function assertDurableBlockPayload(payload: Record<string, unknown>): asserts payload is DurableBlockPayload {
  if (
    typeof payload.type !== 'string' ||
    !SUPPORTED_DURABLE_BLOCK_TYPES_SET.has(payload.type)
  ) {
    throw new Error(
      `Unsupported durable block type: ${String(payload.type)}. Use one of ${SUPPORTED_DURABLE_BLOCK_TYPES.join(', ')}`,
    );
  }

  if (typeof payload.content !== 'string' || payload.content.trim().length === 0) {
    throw new Error('Durable block payload requires non-empty content');
  }

  if (!Array.isArray(payload.tags) || payload.tags.some((tag) => typeof tag !== 'string')) {
    throw new Error('Durable block payload requires string tags');
  }
}

export async function appendDurableBlock(
  store: IStore,
  chain: string,
  input: {
    type: SupportedDurableBlockType;
    content: string;
    tags?: unknown[];
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const payload = createDurableBlockPayload(input);
  assertDurableBlockPayload(payload);
  const block = await store.append(chain, payload);

  try {
    indexExactSearchBlock(
      {
        chain,
        index: block.index,
        hash: block.hash,
        data: payload,
      },
      process.env,
    );
  } catch {
    // Exact search stays rebuildable derived state.
  }
}
