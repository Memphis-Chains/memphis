import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { OrchestrationService } from '../modules/orchestration/service.js';
import type { ProviderName } from '../core/types.js';
import { runChatOnce } from './screens/chat-screen.js';
import { renderHealthScreen } from './screens/health-screen.js';
import { embedSearchScreen, embedStoreScreen } from './screens/embed-screen.js';
import { runEmbedReset, runVaultAdd, runVaultGet, runVaultInit, runVaultList } from './adapters/command-parity.js';

export type TuiOptions = {
  orchestration: OrchestrationService;
  provider?: 'auto' | ProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
};

function printHelp(): void {
  console.log('memphis tui (screen-mode):');
  console.log('  /help');
  console.log('  /exit');
  console.log('  /health');
  console.log('  /provider <auto|shared-llm|decentralized-llm|local-fallback>');
  console.log('  /strategy <default|latency-aware>');
  console.log('  /model <id>');
  console.log('  /vault init <passphrase> <question> <answer>');
  console.log('  /vault add <key> <value>');
  console.log('  /vault get <key>');
  console.log('  /vault list [key]');
  console.log('  /embed reset');
  console.log('  /embed store <id> <value>');
  console.log('  /embed search <query> [topK] [tuned=true|false]');
  console.log('  anything else => chat prompt');
}

export async function runTuiApp(options: TuiOptions): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const state = {
    provider: options.provider ?? 'auto',
    strategy: options.strategy ?? 'default',
    model: options.model,
  } as { provider: 'auto' | ProviderName; strategy: 'default' | 'latency-aware'; model?: string };

  printHelp();

  try {
    while (true) {
      const line = (await rl.question('memphis:tui> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/help') {
        printHelp();
        continue;
      }

      if (line === '/health') {
        console.log(await renderHealthScreen(options.orchestration));
        continue;
      }

      if (line.startsWith('/provider ')) {
        const next = line.slice('/provider '.length).trim() as 'auto' | ProviderName;
        if (next === 'auto' || next === 'shared-llm' || next === 'decentralized-llm' || next === 'local-fallback') {
          state.provider = next;
          console.log(`ok: provider=${next}`);
        } else {
          console.log(`error: unsupported provider=${next}`);
        }
        continue;
      }

      if (line.startsWith('/strategy ')) {
        const next = line.slice('/strategy '.length).trim() as 'default' | 'latency-aware';
        if (next === 'default' || next === 'latency-aware') {
          state.strategy = next;
          console.log(`ok: strategy=${next}`);
        } else {
          console.log(`error: unsupported strategy=${next}`);
        }
        continue;
      }

      if (line.startsWith('/model ')) {
        state.model = line.slice('/model '.length).trim();
        console.log(`ok: model=${state.model}`);
        continue;
      }

      if (line.startsWith('/vault ')) {
        const [cmd, sub, ...rest] = line.split(' ');
        void cmd;
        if (sub === 'init' && rest.length >= 3) console.log(runVaultInit(rest[0], rest[1], rest.slice(2).join(' ')));
        else if (sub === 'add' && rest.length >= 2) console.log(runVaultAdd(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'get' && rest.length >= 1) console.log(runVaultGet(rest[0]));
        else if (sub === 'list') console.log(runVaultList(rest[0]));
        else console.log('error: usage /vault init|add|get|list ...');
        continue;
      }

      if (line.startsWith('/embed ')) {
        const [, sub, ...rest] = line.split(' ');
        if (sub === 'reset') console.log(runEmbedReset());
        else if (sub === 'store' && rest.length >= 2) console.log(embedStoreScreen(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'search' && rest.length >= 1) {
          const query = rest[0];
          const topK = rest[1] ? Number(rest[1]) : 5;
          const tuned = rest[2] ? rest[2] === 'true' : false;
          console.log(embedSearchScreen(query, Number.isFinite(topK) ? topK : 5, tuned));
        } else console.log('error: usage /embed reset|store|search ...');
        continue;
      }

      console.log(await runChatOnce(options.orchestration, line, state));
    }
  } finally {
    rl.close();
  }
}
