import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ConversationTurn } from '../cli/ask-session.js';

type StoredConversation = {
  turns: Array<Omit<ConversationTurn, 'timestamp'> & { timestamp: string }>;
  savedAt: string;
};

export class ConversationHistory {
  private turns: ConversationTurn[] = [];

  constructor(private readonly persistencePath?: string) {
    if (this.persistencePath && existsSync(this.persistencePath)) {
      this.load();
    }
  }

  addTurn(role: 'user' | 'assistant' | 'system', content: string): void {
    const turn: ConversationTurn = {
      role,
      content,
      timestamp: new Date(),
      tokenCount: Math.ceil(content.length / 4),
    };
    this.turns.push(turn);

    if (this.persistencePath) {
      this.save();
    }
  }

  getTurns(): ConversationTurn[] {
    return [...this.turns];
  }

  clear(): void {
    this.turns = [];
    if (this.persistencePath) {
      this.save();
    }
  }

  private save(): void {
    if (!this.persistencePath) return;

    const data: StoredConversation = {
      turns: this.turns.map((turn) => ({ ...turn, timestamp: turn.timestamp.toISOString() })),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(this.persistencePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private load(): void {
    if (!this.persistencePath || !existsSync(this.persistencePath)) return;

    try {
      const data = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as StoredConversation;
      this.turns = (data.turns ?? []).map((turn) => ({
        ...turn,
        timestamp: new Date(turn.timestamp),
      }));
    } catch (error) {
      console.warn('Failed to load conversation history:', error);
      this.turns = [];
    }
  }
}
