export type AskStrategy = 'default' | 'latency-aware';

export interface AskSessionConfig {
  provider: string;
  model: string;
  strategy: AskStrategy;
  maxTokens: number;
  contextWindow: number;
  temperature: number;
  systemPrompt?: string;
  persistencePath?: string;
}

export interface ConversationTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  tokenCount: number;
}
