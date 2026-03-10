import type { ConversationTurn } from '../cli/ask-session.js';

export class ContextWindowManager {
  private readonly maxSize: number;
  private readonly reservedTokens = 1000;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  buildContext(turns: ConversationTurn[]): ConversationTurn[] {
    if (turns.length === 0) return [];

    const availableTokens = Math.max(1, this.maxSize - this.reservedTokens);
    let currentTokens = 0;
    const selectedTurns: ConversationTurn[] = [];

    const systemTurns = turns.filter((turn) => turn.role === 'system');
    for (const turn of systemTurns) {
      if (currentTokens + turn.tokenCount > availableTokens) break;
      selectedTurns.push(turn);
      currentTokens += turn.tokenCount;
    }

    const conversationTurns = turns.filter((turn) => turn.role !== 'system').reverse();
    for (const turn of conversationTurns) {
      if (currentTokens + turn.tokenCount > availableTokens) {
        if (selectedTurns.length === 0) {
          selectedTurns.unshift(turn);
        }
        break;
      }
      selectedTurns.unshift(turn);
      currentTokens += turn.tokenCount;
    }

    return selectedTurns;
  }

  reset(): void {
    // no-op; stateless by design
  }

  getContextUsage(turns: ConversationTurn[]): number {
    const totalTokens = turns.reduce((sum, turn) => sum + turn.tokenCount, 0);
    return Math.round((totalTokens / this.maxSize) * 100);
  }
}
