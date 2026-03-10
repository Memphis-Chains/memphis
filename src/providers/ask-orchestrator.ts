import { createAppContainer } from '../app/container.js';
import { loadConfig } from '../infra/config/env.js';
import type { ProviderName } from '../core/types.js';
import type { ConversationTurn } from '../cli/ask-session.js';

export type AskOrchestratorConfig = {
  provider: string;
  model: string;
  strategy: 'default' | 'latency-aware';
};

export class AskOrchestrator {
  private readonly container = createAppContainer(loadConfig());

  constructor(private readonly config: AskOrchestratorConfig) {}

  async askWithContext(
    input: string,
    context: ConversationTurn[],
    options: { maxTokens: number; temperature: number },
  ): Promise<{ content: string; provider: string; model: string; latency: number }> {
    const contextPrefix =
      context.length === 0
        ? ''
        : `Conversation context:\n${context.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join('\n')}\n\n`;

    const payload = `${contextPrefix}USER: ${input}`;
    const result = await this.container.orchestration.generate({
      input: payload,
      provider: this.normalizeProvider(this.config.provider),
      model: this.config.model,
      strategy: this.config.strategy,
      options: {
        maxTokens: options.maxTokens,
        temperature: options.temperature,
      },
    });

    return {
      content: result.output,
      provider: result.providerUsed,
      model: result.modelUsed ?? this.config.model,
      latency: result.timingMs,
    };
  }

  private normalizeProvider(provider: string): 'auto' | ProviderName {
    if (provider === 'auto') return 'auto';
    if (provider === 'shared-llm' || provider === 'decentralized-llm' || provider === 'local-fallback') {
      return provider;
    }
    return 'auto';
  }
}
