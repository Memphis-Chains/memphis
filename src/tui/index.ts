import readline from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import type { OrchestrationService } from '../modules/orchestration/service.js';
import type { ProviderName } from '../core/types.js';
import { renderHealthScreen } from './screens/health-screen.js';
import { embedSearchScreen, embedStoreScreen } from './screens/embed-screen.js';
import { runEmbedReset, runVaultAdd, runVaultGet, runVaultInit, runVaultList } from './adapters/command-parity.js';
import { keybindToScreen, normalizeScreen, type TuiScreen } from './core.js';

export type TuiOptions = {
  orchestration: OrchestrationService;
  provider?: 'auto' | ProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
};

type TuiState = {
  provider: 'auto' | ProviderName;
  strategy: 'default' | 'latency-aware';
  model?: string;
  screen: TuiScreen;
};

type Observability = {
  requests: number;
  fallbackAttempts: number;
  totalAttempts: number;
  avgTimingMs: number;
  recentTimingsMs: number[];
  lastProvider?: string;
  lastError?: string;
  lastHealthSummary?: string;
};

const MAX_HISTORY_LINES = 260;
const MAX_TIMING_SAMPLES = 12;

function commandHelpLines(): string[] {
  return [
    '/help',
    '/exit',
    '/health',
    '/obs',
    '/screen <chat|health|embed|vault>',
    '/provider <auto|shared-llm|decentralized-llm|local-fallback>',
    '/strategy <default|latency-aware>',
    '/model <id>',
    '/vault init <passphrase> <question> <answer>',
    '/vault add <key> <value>',
    '/vault get <key>',
    '/vault list [key]',
    '/embed reset',
    '/embed store <id> <value>',
    '/embed search <query> [topK] [tuned=true|false]',
    'anything else => chat prompt',
    'keybinds: Ctrl+L clear-screen, Ctrl+K clear-history, Ctrl+1..4 switch screen',
  ];
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function clip(value: string, width: number): string {
  if (width <= 1) return '…';
  return value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
}

function wrapLine(value: string, width: number): string[] {
  if (width <= 0) return [''];
  if (value.length <= width) return [value];

  const out: string[] = [];
  let rest = value;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapLine(line, width));
}

function pushHistory(history: string[], text: string): void {
  for (const line of splitLines(text)) history.push(line);
  if (history.length > MAX_HISTORY_LINES) history.splice(0, history.length - MAX_HISTORY_LINES);
}

function formatStatusLine(state: TuiState, width: number): string {
  const model = state.model?.trim().length ? state.model : 'default';
  return clip(`screen=${state.screen} | provider=${state.provider} | strategy=${state.strategy} | model=${model}`, width);
}

function formatObservabilityLine(obs: Observability): string {
  const fallbackRate = obs.totalAttempts > 0 ? `${Math.round((obs.fallbackAttempts / obs.totalAttempts) * 100)}%` : 'n/a';
  const recent = obs.recentTimingsMs.length > 0 ? obs.recentTimingsMs.slice(-3).join('/') : 'n/a';
  return `obs req=${obs.requests} avg=${Math.round(obs.avgTimingMs)}ms fallback=${fallbackRate} recent=${recent}ms`; 
}

function buildObservabilityPanelLines(obs: Observability): string[] {
  const fallbackRate = obs.totalAttempts > 0 ? `${Math.round((obs.fallbackAttempts / obs.totalAttempts) * 100)}%` : 'n/a';
  const latencyTrend = obs.recentTimingsMs.length > 0 ? obs.recentTimingsMs.map((x) => `${Math.round(x)}ms`).join(', ') : 'n/a';
  return [
    'Observability:',
    `- requests: ${obs.requests}`,
    `- avg latency: ${Math.round(obs.avgTimingMs)}ms`,
    `- fallback rate: ${fallbackRate}`,
    `- last provider: ${obs.lastProvider ?? 'n/a'}`,
    `- latency trend: ${latencyTrend}`,
    `- last error: ${obs.lastError ?? 'none'}`,
    `- health: ${obs.lastHealthSummary ?? 'n/a'}`,
  ];
}

function rightPanelLines(screen: TuiScreen, obs: Observability): string[] {
  const base = ['Commands:'];
  if (screen === 'chat') return [...base, ...commandHelpLines(), '', ...buildObservabilityPanelLines(obs)];
  if (screen === 'health') return [...base, '/health', '/screen chat', 'hint: chat still works from input', '', ...buildObservabilityPanelLines(obs)];
  if (screen === 'embed') {
    return [...base, '/embed reset', '/embed store <id> <value>', '/embed search <query> [topK] [tuned=true|false]', '', ...buildObservabilityPanelLines(obs)];
  }
  return [
    ...base,
    '/vault init <passphrase> <question> <answer>',
    '/vault add <key> <value>',
    '/vault get <key>',
    '/vault list [key]',
    '',
    ...buildObservabilityPanelLines(obs),
  ];
}

function drawFullScreen(state: TuiState, history: string[], obs: Observability, liveLine?: string): void {
  const termWidth = Math.max(80, output.columns || 80);
  const termHeight = Math.max(24, output.rows || 24);

  const leftWidth = Math.max(24, Math.floor(termWidth * 0.68));
  const rightWidth = termWidth - leftWidth - 3;
  const availableBodyRows = termHeight - 5;

  output.write('\x1b[2J\x1b[H');
  console.log(clip('Memphis TUI · full-screen baseline (pane mode)', termWidth));
  console.log(clip(formatStatusLine(state, termWidth), termWidth));
  console.log(clip(formatObservabilityLine(obs), termWidth));
  console.log('-'.repeat(termWidth));

  const historyLines = wrapLines(liveLine ? [...history, liveLine] : history, leftWidth);
  const visibleHistory = historyLines.slice(-availableBodyRows);
  const helpLines = wrapLines(rightPanelLines(state.screen, obs), rightWidth);

  for (let row = 0; row < availableBodyRows; row += 1) {
    const left = clip(visibleHistory[row] ?? '', leftWidth).padEnd(leftWidth, ' ');
    const right = clip(helpLines[row] ?? '', rightWidth).padEnd(rightWidth, ' ');
    console.log(`${left} │ ${right}`);
  }

  console.log('-'.repeat(termWidth));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamOutputToHistory(history: string[], text: string, render: (line?: string) => void): Promise<void> {
  const lines = splitLines(text);
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 18) {
      render(line.slice(0, i + 18));
      await delay(8);
    }
    pushHistory(history, line);
    render();
  }
  if (lines.length === 0) render();
}

function updateObservabilityFromResult(
  obs: Observability,
  result: { providerUsed: string; timingMs: number; trace?: { attempts: Array<{ viaFallback: boolean }> } },
): void {
  obs.requests += 1;
  obs.lastProvider = result.providerUsed;
  obs.recentTimingsMs.push(result.timingMs);
  if (obs.recentTimingsMs.length > MAX_TIMING_SAMPLES) obs.recentTimingsMs.splice(0, obs.recentTimingsMs.length - MAX_TIMING_SAMPLES);
  const sum = obs.recentTimingsMs.reduce((acc, next) => acc + next, 0);
  obs.avgTimingMs = sum / Math.max(1, obs.recentTimingsMs.length);

  if (result.trace) {
    const fallbackCount = result.trace.attempts.filter((a) => a.viaFallback).length;
    obs.fallbackAttempts += fallbackCount;
    obs.totalAttempts += result.trace.attempts.length;
  }
}

export async function runTuiApp(options: TuiOptions): Promise<void> {
  const rl = readline.createInterface({ input, output, terminal: true });
  const state: TuiState = {
    provider: options.provider ?? 'auto',
    strategy: options.strategy ?? 'default',
    model: options.model,
    screen: 'chat',
  };
  const history: string[] = [];
  const observability: Observability = {
    requests: 0,
    fallbackAttempts: 0,
    totalAttempts: 0,
    avgTimingMs: 0,
    recentTimingsMs: [],
  };

  const render = (line?: string) => drawFullScreen(state, history, observability, line);

  if (input.isTTY) {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
  }

  const onKeypress = (_str: string, key: { ctrl?: boolean; name?: string }) => {
    if (!key.ctrl) return;

    if (key.name === 'l') {
      pushHistory(history, '[keybind] screen redraw (Ctrl+L)');
      render();
      return;
    }

    if (key.name === 'k') {
      history.length = 0;
      pushHistory(history, '[keybind] history cleared (Ctrl+K)');
      render();
      return;
    }

    const next = keybindToScreen(key.name);
    if (next) {
      state.screen = next;
      pushHistory(history, `[keybind] active screen=${next} (Ctrl+${key.name})`);
      render();
    }
  };

  input.on('keypress', onKeypress);
  pushHistory(history, 'Started full-screen TUI baseline. Type /help for command hints.');

  try {
    while (true) {
      render();
      const line = (await rl.question('memphis:tui> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      if (line === '/help') {
        pushHistory(history, 'Help:');
        pushHistory(history, commandHelpLines().map((x) => `  ${x}`).join('\n'));
        continue;
      }

      if (line === '/obs') {
        pushHistory(history, buildObservabilityPanelLines(observability).join('\n'));
        continue;
      }

      if (line === '/health') {
        const health = await renderHealthScreen(options.orchestration);
        observability.lastHealthSummary = splitLines(health)[0] ?? health;
        pushHistory(history, health);
        continue;
      }

      if (line.startsWith('/screen ')) {
        const next = normalizeScreen(line.slice('/screen '.length).trim());
        if (next) {
          state.screen = next;
          pushHistory(history, `ok: screen=${next}`);
        } else {
          pushHistory(history, 'error: usage /screen <chat|health|embed|vault>');
        }
        continue;
      }

      if (line.startsWith('/provider ')) {
        const next = line.slice('/provider '.length).trim() as 'auto' | ProviderName;
        if (next === 'auto' || next === 'shared-llm' || next === 'decentralized-llm' || next === 'local-fallback') {
          state.provider = next;
          pushHistory(history, `ok: provider=${next}`);
        } else {
          pushHistory(history, `error: unsupported provider=${next}`);
        }
        continue;
      }

      if (line.startsWith('/strategy ')) {
        const next = line.slice('/strategy '.length).trim() as 'default' | 'latency-aware';
        if (next === 'default' || next === 'latency-aware') {
          state.strategy = next;
          pushHistory(history, `ok: strategy=${next}`);
        } else {
          pushHistory(history, `error: unsupported strategy=${next}`);
        }
        continue;
      }

      if (line.startsWith('/model ')) {
        state.model = line.slice('/model '.length).trim();
        pushHistory(history, `ok: model=${state.model}`);
        continue;
      }

      if (line.startsWith('/vault ')) {
        const [cmd, sub, ...rest] = line.split(' ');
        void cmd;
        if (sub === 'init' && rest.length >= 3) pushHistory(history, runVaultInit(rest[0], rest[1], rest.slice(2).join(' ')));
        else if (sub === 'add' && rest.length >= 2) pushHistory(history, runVaultAdd(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'get' && rest.length >= 1) pushHistory(history, runVaultGet(rest[0]));
        else if (sub === 'list') pushHistory(history, runVaultList(rest[0]));
        else pushHistory(history, 'error: usage /vault init|add|get|list ...');
        continue;
      }

      if (line.startsWith('/embed ')) {
        const [, sub, ...rest] = line.split(' ');
        if (sub === 'reset') pushHistory(history, runEmbedReset());
        else if (sub === 'store' && rest.length >= 2) pushHistory(history, embedStoreScreen(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'search' && rest.length >= 1) {
          const query = rest[0];
          const topK = rest[1] ? Number(rest[1]) : 5;
          const tuned = rest[2] ? rest[2] === 'true' : false;
          pushHistory(history, embedSearchScreen(query, Number.isFinite(topK) ? topK : 5, tuned));
        } else pushHistory(history, 'error: usage /embed reset|store|search ...');
        continue;
      }

      pushHistory(history, `> ${line}`);
      const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦'];
      let frame = 0;
      const spinner = setInterval(() => {
        render(`${spinnerFrames[frame % spinnerFrames.length]} generating response...`);
        frame += 1;
      }, 90);

      try {
        const result = await options.orchestration.generate({
          input: line,
          provider: state.provider,
          model: state.model,
          strategy: state.strategy,
        });

        clearInterval(spinner);
        updateObservabilityFromResult(observability, result);
        observability.lastError = undefined;

        const chunks = [`[provider=${result.providerUsed} model=${result.modelUsed ?? 'n/a'} timing=${result.timingMs}ms]`, result.output];
        if (result.trace) {
          chunks.push('trace:');
          for (const a of result.trace.attempts) {
            chunks.push(
              `  - #${a.attempt} ${a.provider} ${a.viaFallback ? '(fallback)' : '(primary)'} ${a.latencyMs}ms ${a.ok ? 'ok' : `err=${a.errorCode ?? 'unknown'}`}`,
            );
          }
        }

        await streamOutputToHistory(history, chunks.join('\n'), render);
      } catch (error) {
        clearInterval(spinner);
        observability.lastError = error instanceof Error ? error.message : String(error);
        pushHistory(history, `error: ${observability.lastError}`);
      }
    }
  } finally {
    input.off('keypress', onKeypress);
    if (input.isTTY) input.setRawMode?.(false);
    output.write('\x1b[2J\x1b[H');
    rl.close();
  }
}
