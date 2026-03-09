import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import type { ProviderName } from '../../core/types.js';

export type InteractiveTuiOptions = {
  orchestration: OrchestrationService;
  provider?: 'auto' | ProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
};

function printHeader(state: { provider: 'auto' | ProviderName; strategy: 'default' | 'latency-aware'; model?: string }) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║ Memphis interactive TUI                                          ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║ provider=${state.provider.padEnd(15, ' ')} strategy=${state.strategy.padEnd(13, ' ')} model=${(state.model ?? 'default').slice(0, 15).padEnd(15, ' ')}║`);
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('Type prompt and press enter. Commands: /help /provider <name|auto> /strategy <default|latency-aware> /model <id> /health /exit');
}

export async function runInteractiveTui(options: InteractiveTuiOptions): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const state = {
    provider: options.provider ?? 'auto',
    strategy: options.strategy ?? 'default',
    model: options.model,
  } as { provider: 'auto' | ProviderName; strategy: 'default' | 'latency-aware'; model?: string };

  printHeader(state);

  try {
    while (true) {
      const line = (await rl.question('memphis> ')).trim();
      if (!line) continue;

      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        printHeader(state);
        continue;
      }

      if (line.startsWith('/provider ')) {
        const next = line.slice('/provider '.length).trim() as 'auto' | ProviderName;
        if (next === 'auto' || next === 'shared-llm' || next === 'decentralized-llm' || next === 'local-fallback') {
          state.provider = next;
          console.log(`ok: provider=${state.provider}`);
        } else {
          console.log(`error: unsupported provider ${next}`);
        }
        continue;
      }

      if (line.startsWith('/strategy ')) {
        const next = line.slice('/strategy '.length).trim() as 'default' | 'latency-aware';
        if (next === 'default' || next === 'latency-aware') {
          state.strategy = next;
          console.log(`ok: strategy=${state.strategy}`);
        } else {
          console.log(`error: unsupported strategy ${next}`);
        }
        continue;
      }

      if (line.startsWith('/model ')) {
        state.model = line.slice('/model '.length).trim();
        console.log(`ok: model=${state.model}`);
        continue;
      }

      if (line === '/health') {
        const providers = await options.orchestration.providersHealth();
        for (const p of providers) {
          console.log(`- ${p.name.padEnd(18, ' ')} ${p.ok ? 'ok' : 'down'} ${p.latencyMs ? `${p.latencyMs}ms` : ''} ${p.error ?? ''}`);
        }
        continue;
      }

      try {
        const result = await options.orchestration.generate({
          input: line,
          provider: state.provider,
          model: state.model,
          strategy: state.strategy,
        });

        console.log(`\n[provider=${result.providerUsed} model=${result.modelUsed ?? 'n/a'} timing=${result.timingMs}ms]`);
        if (result.trace) {
          console.log('trace:');
          for (const a of result.trace.attempts) {
            const suffix = a.ok ? 'ok' : `err=${a.errorCode ?? 'unknown'}`;
            console.log(`  - #${a.attempt} ${a.provider} ${a.viaFallback ? '(fallback)' : '(primary)'} ${a.latencyMs}ms ${suffix}`);
          }
        }
        console.log(result.output);
        console.log('');
      } catch (error) {
        console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    rl.close();
  }
}
