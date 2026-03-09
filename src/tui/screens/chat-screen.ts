import type { OrchestrationService } from '../../modules/orchestration/service.js';
import type { ProviderName } from '../../core/types.js';

export type ChatState = {
  provider: 'auto' | ProviderName;
  strategy: 'default' | 'latency-aware';
  model?: string;
};

export async function runChatOnce(
  orchestration: OrchestrationService,
  input: string,
  state: ChatState,
): Promise<string> {
  const result = await orchestration.generate({
    input,
    provider: state.provider,
    model: state.model,
    strategy: state.strategy,
  });

  const lines = [`[provider=${result.providerUsed} model=${result.modelUsed ?? 'n/a'} timing=${result.timingMs}ms]`, result.output];
  if (result.trace) {
    lines.push('trace:');
    for (const a of result.trace.attempts) {
      lines.push(
        `  - #${a.attempt} ${a.provider} ${a.viaFallback ? '(fallback)' : '(primary)'} ${a.latencyMs}ms ${a.ok ? 'ok' : `err=${a.errorCode ?? 'unknown'}`}`,
      );
    }
  }

  return lines.join('\n');
}
