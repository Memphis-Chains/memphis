import { recordDecisionHistoryEntry } from '../../core/decision-history-store.js';
import { createDecision } from '../../core/decision-lifecycle.js';

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
  recordDecision: typeof recordDecisionHistoryEntry;
};

export async function runMemphisDecide(
  input: MemphisDecideInput,
  deps: DecideDeps = {
    recordDecision: recordDecisionHistoryEntry,
  },
): Promise<MemphisDecideOutput> {
  const decisionId = `mcp-${Date.now().toString(36)}`;
  const decision = createDecision({
    id: decisionId,
    title: input.title,
    chosen: input.choice,
    options: [input.choice],
    context: input.context,
  });

  const entry = await deps.recordDecision(decision, {
    correlationId: `mcp:${decisionId}`,
    source: 'mcp',
    fallbackTags: ['decision', 'mcp'],
  });

  return {
    success: true,
    index: entry.chainRef?.index ?? 0,
  };
}
