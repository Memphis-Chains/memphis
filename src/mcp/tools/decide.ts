import { createHash } from 'node:crypto';

import { appendDecisionHistory } from '../../core/decision-history-store.js';
import { createDecision } from '../../core/decision-lifecycle.js';
import { indexExactSearchBlock } from '../../infra/memory/exact-search.js';
import { appendBlock } from '../../infra/storage/chain-adapter.js';

export type MemphisDecideInput = {
  title: string;
  choice: string;
  context?: string;
};

export type MemphisDecideOutput = {
  success: boolean;
  index: number;
};

export type DecideDeps = {
  append: typeof appendBlock;
  appendHistory: typeof appendDecisionHistory;
  indexExact?: typeof indexExactSearchBlock;
};

export async function runMemphisDecide(
  input: MemphisDecideInput,
  deps: DecideDeps = {
    append: appendBlock,
    appendHistory: appendDecisionHistory,
    indexExact: indexExactSearchBlock,
  },
): Promise<MemphisDecideOutput> {
  const block = await deps.append('decisions', {
    title: input.title,
    choice: input.choice,
    context: input.context,
    source: 'mcp',
  });

  try {
    deps.indexExact?.(
      {
        chain: 'decisions',
        index: block.index,
        hash: block.hash,
        data: {
          title: input.title,
          choice: input.choice,
          context: input.context,
          source: 'mcp',
        },
      },
      process.env,
    );
  } catch {
    // Exact search is rebuildable from chain source data.
  }

  const decision = createDecision({
    id: `mcp-${block.index}`,
    title: input.title,
    chosen: input.choice,
    options: [input.choice],
    context: input.context,
  });

  deps.appendHistory(decision, {
    correlationId: `mcp:${block.index}`,
    chainRef: {
      chain: 'decisions',
      index: block.index,
      hash: createHash('sha256')
        .update(
          JSON.stringify({
            title: input.title,
            choice: input.choice,
            context: input.context ?? null,
            index: block.index,
          }),
        )
        .digest('hex'),
    },
  });

  return {
    success: true,
    index: block.index,
  };
}
