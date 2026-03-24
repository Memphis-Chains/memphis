import { getDataDir } from '../../config/paths.js';
import { readDecisionHistory } from '../../core/decision-history-store.js';

export type Decision = {
  hash: string;
  question: string;
  choice: string;
};

export type DecisionScreenState = {
  loading: boolean;
  error: string | null;
  decisions: Decision[];
};

export async function loadDecisionScreen(
  loadDecisions: () => Promise<Decision[]>,
): Promise<DecisionScreenState> {
  try {
    const decisions = await loadDecisions();
    return { loading: false, error: null, decisions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      loading: false,
      error: `Failed to load decisions: ${message}`,
      decisions: [],
    };
  }
}

export function renderDecisionScreen(state: DecisionScreenState): string {
  if (state.loading) return 'Loading decisions...';
  if (state.error) return `❌ ${state.error}\nCheck chain integrity with: memphis verify`;
  if (state.decisions.length === 0) {
    return 'No decisions recorded yet.\nCreate one with: memphis decide "your question" "your choice"';
  }
  return `📋 Decision History (${state.decisions.length})`;
}

export async function loadDecisionsFromChain(): Promise<Decision[]> {
  const dataDir = getDataDir();
  const historyPath = `${dataDir}/decision-history.jsonl`;
  const entries = readDecisionHistory(historyPath);
  return entries.map((entry) => ({
    hash: entry.decision.id,
    question: entry.decision.title,
    choice: entry.decision.chosen ?? entry.decision.options[0] ?? '',
  }));
}
