import { stdin as input, stdout as output } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import readline from 'node:readline/promises';

import type { ProviderName } from '../core/types.js';
import type {
  Provider,
  ChatMessage,
  ChatToolDefinition,
  ChatToolCall,
} from '../providers/index.js';
import {
  runEmbedReset,
  runVaultAdd,
  runVaultGet,
  runVaultInit,
  runVaultList,
} from './adapters/command-parity.js';
import { TuiScreen, keybindToScreen, normalizeScreen } from './core.js';
import { DashboardData, loadDashboardData } from './dashboard-data.js';
import {
  appendSnapshot,
  loadLatestSnapshot,
  loadSnapshots,
  observabilityPathFromEnv,
  resetSnapshots,
} from './observability-store.js';
import { renderOperatorGuideLines } from '../infra/operator-guide.js';
import { renderDashboardScreen } from './screens/DashboardScreen.js';
import { loadDecisionsFromChain } from './screens/decision-screen.js';
import { embedSearchScreen, embedStoreScreen } from './screens/embed-screen.js';
import { renderHealthScreen } from './screens/health-screen.js';
import {
  BOLD,
  BOX,
  BOX_BOLD,
  DIM,
  FG_CHAIN,
  FG_COPPER,
  FG_COPPER_BRIGHT,
  FG_EMBED,
  FG_OXIDE,
  FG_STEEL,
  FG_TEAL,
  FG_VAULT,
  FG_WARM,
  FG_WHITE,
  MEMPHIS_LOGO_COMPACT,
  RESET,
  clip as themeClip,
  padEnd as themePadEnd,
  sparkline,
  statusDot,
  stripAnsi,
  visualLength,
} from './theme.js';
import type { OrchestrationService } from '../modules/orchestration/service.js';

export type TuiOptions = {
  orchestration: OrchestrationService;
  provider?: 'auto' | ProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
  /** Chat provider for real LLM conversations (Provider.chat interface) */
  chatProvider?: Provider;
  /** System prompt for chat conversations */
  systemPrompt?: string;
  /** MCP tool definitions available to the chat provider */
  tools?: ChatToolDefinition[];
  /** Executor for MCP tool calls */
  toolExecutor?: (call: ChatToolCall) => Promise<string>;
};

type TuiState = {
  provider: 'auto' | ProviderName;
  strategy: 'default' | 'latency-aware';
  model?: string;
  screen: TuiScreen;
  mode: 'normal' | 'palette';
  paletteInput: string;
  dashboardData?: DashboardData;
  chatMessages: ChatMessage[];
  scrollOffset: number;
  generatingSince?: number;
  lastStep?: number;
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
  lastPersistedTs?: string;
};

const MAX_HISTORY_LINES = 500;
const MAX_MESSAGES = 40;
const MAX_TIMING_SAMPLES = 12;
const RENDER_DEBOUNCE_MS = 28;
const STREAM_CHUNK_CHARS = 18;
const STREAM_FRAME_DELAY_MS = 8;
const STREAM_ANIMATION_CHAR_LIMIT = 2000;
const SPINNER_FRAMES = [
  `${FG_COPPER}\u2847${RESET}`,
  `${FG_COPPER_BRIGHT}\u2857${RESET}`,
  `${FG_COPPER}\u2867${RESET}`,
  `${FG_COPPER_BRIGHT}\u28b7${RESET}`,
  `${FG_COPPER}\u28f7${RESET}`,
  `${FG_COPPER_BRIGHT}\u28ef${RESET}`,
  `${FG_COPPER}\u28df${RESET}`,
  `${FG_COPPER_BRIGHT}\u28bf${RESET}`,
] as const;

const COMMAND_HELP_LINES = [
  `${FG_COPPER}/help${RESET}               ${FG_STEEL}show commands${RESET}`,
  `${FG_COPPER}/guide${RESET}              ${FG_STEEL}runtime guide${RESET}`,
  `${FG_COPPER}/exit${RESET}               ${FG_STEEL}quit${RESET}`,
  `${FG_COPPER}/health${RESET}             ${FG_STEEL}provider status${RESET}`,
  `${FG_COPPER}/obs${RESET}                ${FG_STEEL}observability${RESET}`,
  `${FG_COPPER}/screen${RESET} ${FG_WARM}<name>${RESET}      ${FG_STEEL}switch screen${RESET}`,
  `${FG_COPPER}/provider${RESET} ${FG_WARM}<name>${RESET}    ${FG_STEEL}set provider${RESET}`,
  `${FG_COPPER}/strategy${RESET} ${FG_WARM}<type>${RESET}    ${FG_STEEL}routing mode${RESET}`,
  `${FG_COPPER}/model${RESET} ${FG_WARM}<id>${RESET}         ${FG_STEEL}set model${RESET}`,
  `${FG_COPPER}/vault${RESET} ${FG_WARM}<cmd>${RESET}        ${FG_STEEL}vault ops${RESET}`,
  `${FG_COPPER}/embed${RESET} ${FG_WARM}<cmd>${RESET}        ${FG_STEEL}embeddings${RESET}`,
  `${DIM}anything else => chat prompt${RESET}`,
  '',
  `${FG_STEEL}Ctrl+1..5${RESET} ${DIM}switch screen${RESET}`,
  `${FG_STEEL}Ctrl+L${RESET}    ${DIM}redraw${RESET}  ${FG_STEEL}Ctrl+K${RESET} ${DIM}clear${RESET}`,
  `${FG_STEEL}Ctrl+P${RESET}    ${DIM}command palette${RESET}  ${FG_STEEL}Ctrl+Tab${RESET} ${DIM}next tab${RESET}`,
] as const;

function commandHelpLines(): string[] {
  return [...COMMAND_HELP_LINES];
}

function renderTabBar(screen: TuiScreen): string {
  const tabs: TuiScreen[] = ['dashboard', 'chat', 'health', 'embed', 'vault', 'decisions'];
  return tabs.map((t) => (t === screen ? `[${t.toUpperCase()}]` : ` ${t} `)).join(' ');
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, '\n').split('\n');
}

function clip(value: string, width: number): string {
  return themeClip(value, width);
}

function wrapLine(value: string, width: number): string[] {
  if (width <= 0) return [''];
  const vlen = visualLength(value);
  if (vlen <= width) return [value];

  // For ANSI-colored strings, use visual length
  const stripped = stripAnsi(value);
  if (stripped.length <= width) return [value];

  const out: string[] = [];
  let rest = stripped;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

function wrapLines(lines: string[], width: number): string[] {
  const out: string[] = [];
  for (const line of lines) {
    out.push(...wrapLine(line, width));
  }
  return out;
}

function renderStatusBar(state: TuiState): string {
  const parts: string[] = [];

  // Thinking timer
  if (state.generatingSince) {
    const sec = Math.floor((Date.now() - state.generatingSince) / 1000);
    parts.push(`${FG_COPPER}\u23f3 ${sec}s${RESET}`);
  }

  // Step
  if (state.lastStep) {
    parts.push(`${FG_TEAL}step ${state.lastStep}/32${RESET}`);
  }

  // Provider
  parts.push(`${FG_STEEL}[provider ${state.provider}]${RESET}`);

  // Context meter
  const ctxPct = Math.round((state.chatMessages.length / MAX_MESSAGES) * 100);
  const filled = Math.round((ctxPct / 100) * 10);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
  parts.push(`${FG_STEEL}ctx ${FG_COPPER}${bar}${RESET} ${ctxPct}%`);

  return parts.join('  ');
}

function pushHistory(history: string[], text: string): void {
  for (const line of splitLines(text)) history.push(line);
  if (history.length > MAX_HISTORY_LINES) history.splice(0, history.length - MAX_HISTORY_LINES);
}

function screenColor(screen: TuiScreen): string {
  if (screen === 'chat') return FG_COPPER_BRIGHT;
  if (screen === 'health') return FG_TEAL;
  if (screen === 'embed') return FG_EMBED;
  if (screen === 'vault') return FG_VAULT;
  return FG_CHAIN;
}

function formatStatusLine(state: TuiState, width: number): string {
  const model = state.model?.trim().length ? state.model : 'default';
  const sc = screenColor(state.screen);
  let status =
    `${sc}${BOLD}${state.screen.toUpperCase()}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}provider${RESET}=${FG_COPPER}${state.provider}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}strategy${RESET}=${FG_COPPER}${state.strategy}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}model${RESET}=${FG_COPPER}${model}${RESET}`;
  if (state.scrollOffset > 0) status += ` ${FG_STEEL}\u2502${RESET} ${FG_COPPER}[Scroll: ${state.scrollOffset} up]${RESET}`;
  return clip(status, width);
}

function relativeAge(ts?: string): string {
  if (!ts) return 'n/a';
  const deltaMs = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'n/a';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hrs = Math.floor(min / 60);
  return `${hrs}h`;
}

function formatObservabilityLine(obs: Observability): string {
  const fallbackRate =
    obs.totalAttempts > 0
      ? `${Math.round((obs.fallbackAttempts / obs.totalAttempts) * 100)}%`
      : 'n/a';
  const spark =
    obs.recentTimingsMs.length > 0
      ? `${FG_COPPER}${sparkline(obs.recentTimingsMs)}${RESET}`
      : `${FG_STEEL}---${RESET}`;
  const age = relativeAge(obs.lastPersistedTs);
  return (
    `${FG_STEEL}req${RESET}=${FG_WARM}${obs.requests}${RESET} ` +
    `${FG_STEEL}avg${RESET}=${FG_WARM}${Math.round(obs.avgTimingMs)}ms${RESET} ` +
    `${FG_STEEL}fb${RESET}=${FG_WARM}${fallbackRate}${RESET} ` +
    `${FG_STEEL}latency${RESET} ${spark} ` +
    `${FG_STEEL}snap${RESET}=${FG_WARM}${age}${RESET}`
  );
}

function buildObservabilityPanelLines(obs: Observability): string[] {
  const fallbackRate =
    obs.totalAttempts > 0
      ? `${Math.round((obs.fallbackAttempts / obs.totalAttempts) * 100)}%`
      : 'n/a';
  const spark =
    obs.recentTimingsMs.length > 0 ? `${FG_COPPER}${sparkline(obs.recentTimingsMs)}${RESET}` : '';
  const errLine = obs.lastError
    ? `${FG_OXIDE}${obs.lastError.slice(0, 40)}${RESET}`
    : `${FG_TEAL}none${RESET}`;
  return [
    `${FG_COPPER_BRIGHT}${BOLD}Observability${RESET}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}requests${RESET}   ${FG_WHITE}${obs.requests}${RESET}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}avg ms${RESET}     ${FG_WHITE}${Math.round(obs.avgTimingMs)}${RESET}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}fallback${RESET}   ${FG_WHITE}${fallbackRate}${RESET}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}provider${RESET}   ${FG_COPPER}${obs.lastProvider ?? 'n/a'}${RESET}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}latency${RESET}    ${spark}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}error${RESET}      ${errLine}`,
    `${FG_STEEL}\u2502${RESET} ${FG_WARM}health${RESET}     ${obs.lastHealthSummary ?? `${FG_STEEL}n/a${RESET}`}`,
    `${FG_STEEL}\u2514${RESET} ${FG_WARM}persisted${RESET}  ${FG_STEEL}${relativeAge(obs.lastPersistedTs)}${RESET}`,
  ];
}

function rightPanelLines(screen: TuiScreen, obs: Observability): string[] {
  const header = `${FG_COPPER}${BOLD}Commands${RESET}`;
  const sep = `${FG_STEEL}${BOX.h.repeat(3)}${RESET}`;
  if (screen === 'chat')
    return [header, ...commandHelpLines(), sep, ...buildObservabilityPanelLines(obs)];
  if (screen === 'health')
    return [
      header,
      `${FG_COPPER}/health${RESET}         ${FG_STEEL}refresh${RESET}`,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}chat${RESET}   ${FG_STEEL}back to chat${RESET}`,
      `${DIM}chat still works from input${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  if (screen === 'embed') {
    return [
      header,
      `${FG_COPPER}/embed reset${RESET}`,
      `${FG_COPPER}/embed store${RESET} ${FG_WARM}<id> <val>${RESET}`,
      `${FG_COPPER}/embed search${RESET} ${FG_WARM}<q> [topK]${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  if (screen === 'dashboard') {
    return [
      header,
      `${FG_COPPER_BRIGHT}J${RESET}${FG_STEEL}ournal${RESET}  ${FG_COPPER_BRIGHT}A${RESET}${FG_STEEL}sk${RESET}  ${FG_COPPER_BRIGHT}R${RESET}${FG_STEEL}ecall${RESET}  ${FG_COPPER_BRIGHT}Q${RESET}${FG_STEEL}uit${RESET}`,
      `${DIM}auto refresh: 5s${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  if (screen === 'decisions') {
    return [
      header,
      `${FG_COPPER}/decisions list${RESET}`,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}chat${RESET}   ${FG_STEEL}back to chat${RESET}`,
      `${DIM}records from decision-history.jsonl${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  return [
    header,
    `${FG_COPPER}/vault init${RESET} ${FG_WARM}<pass> <q> <a>${RESET}`,
    `${FG_COPPER}/vault add${RESET}  ${FG_WARM}<key> <val>${RESET}`,
    `${FG_COPPER}/vault get${RESET}  ${FG_WARM}<key>${RESET}`,
    `${FG_COPPER}/vault list${RESET} ${FG_WARM}[key]${RESET}`,
    sep,
    ...buildObservabilityPanelLines(obs),
  ];
}

function equalStringArrays(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function equalDashboardData(current?: DashboardData, next?: DashboardData): boolean {
  if (!current || !next) return false;

  if (
    current.stats.totalBlocks !== next.stats.totalBlocks ||
    current.stats.todayBlocks !== next.stats.todayBlocks ||
    current.stats.modelStatus !== next.stats.modelStatus ||
    current.stats.embeddingCount !== next.stats.embeddingCount ||
    current.stats.uptime !== next.stats.uptime
  ) {
    return false;
  }

  if (current.activities.length !== next.activities.length) return false;
  for (let i = 0; i < current.activities.length; i += 1) {
    const lhs = current.activities[i];
    const rhs = next.activities[i];
    if (lhs?.time !== rhs?.time || lhs?.message !== rhs?.message) {
      return false;
    }
  }

  return (
    current.insights.patternsLoaded === next.insights.patternsLoaded &&
    current.insights.learningAccuracy === next.insights.learningAccuracy &&
    current.insights.suggestionsPending === next.insights.suggestionsPending &&
    equalStringArrays(current.insights.topTopics, next.insights.topTopics)
  );
}

function drawFullScreen(
  state: TuiState,
  history: string[],
  obs: Observability,
  leftWidth: number,
  liveLine?: string,
): void {
  const termWidth = Math.max(80, output.columns || 80);
  const termHeight = Math.max(24, output.rows || 24);

  const rightWidth = termWidth - leftWidth - 3;
  const tabBarRows = 1;
  const availableBodyRows = termHeight - 6 - tabBarRows; // header(3) + top border(1) + bottom bar(1) + input(1) + tabBar(1)

  output.write('\x1b[H'); // cursor home (no full clear — avoids flicker)

  // ── Tab bar ───────────────────────────────────────────────────────────────
  output.write(`${FG_STEEL}${renderTabBar(state.screen)}${RESET}\n`);

  // ── Header ────────────────────────────────────────────────────────────────
  const sc = screenColor(state.screen);
  const headerLeft = `${MEMPHIS_LOGO_COMPACT} ${FG_STEEL}${BOX.v}${RESET} ${sc}${BOLD}${state.screen.toUpperCase()}${RESET}`;
  const headerRight = formatObservabilityLine(obs);
  const headerGap = Math.max(
    1,
    termWidth - visualLength(headerLeft) - visualLength(headerRight) - 1,
  );
  output.write(`${headerLeft}${' '.repeat(headerGap)}${headerRight}\n`);

  // ── Status line ───────────────────────────────────────────────────────────
  output.write(`${formatStatusLine(state, termWidth)}\n`);

  // ── Top border ────────────────────────────────────────────────────────────
  const borderH = BOX_BOLD.h;
  const leftBorder = borderH.repeat(leftWidth);
  const rightBorder = borderH.repeat(rightWidth);
  output.write(
    `${FG_COPPER}${BOX_BOLD.tl}${leftBorder}${BOX_BOLD.tee_down}${rightBorder}${BOX_BOLD.tr}${RESET}\n`,
  );

  // ── Body ──────────────────────────────────────────────────────────────────
  if (state.mode === 'palette') {
    // Palette mode - show command list with fuzzy filter
    const commands = [
      '/backup list', '/backup create',
      '/insights', '/connections scan', '/suggest',
      '/decisions list', '/decide',
      '/sync status', '/sync push',
      '/screen dashboard', '/screen chat', '/screen health', '/screen embed', '/screen vault',
      '/provider auto', '/provider ollama', '/provider shared-llm', '/provider local-fallback',
      '/strategy default', '/strategy latency-aware',
      '/model', '/vault init', '/vault add', '/vault get', '/vault list',
      '/embed reset', '/embed store', '/embed search',
      '/health', '/obs', '/obs export', '/obs reset',
      '/guide', '/help', '/exit',
    ];
    const filtered = state.paletteInput
      ? commands.filter((c) => c.toLowerCase().includes(state.paletteInput.toLowerCase()))
      : commands;

    for (let row = 0; row < availableBodyRows; row += 1) {
      const cmd = filtered[row] ?? '';
      const leftContent = cmd;
      const rightContent = '';
      const left = themePadEnd(clip(leftContent, leftWidth - 1), leftWidth - 1);
      const right = themePadEnd(clip(rightContent, rightWidth - 1), rightWidth - 1);
      output.write(
        `${FG_COPPER}${BOX_BOLD.v}${RESET}${left} ${FG_STEEL}${BOX_BOLD.v}${RESET}${right}${FG_STEEL}${BOX_BOLD.v}${RESET}\n`,
      );
    }
  } else {
    const dashboardLines =
      state.screen === 'dashboard' && state.dashboardData
        ? renderDashboardScreen(state.dashboardData, leftWidth)
        : null;
    const historyLines = dashboardLines
      ? dashboardLines
      : wrapLines(liveLine ? [...history, liveLine] : history, leftWidth);
    const visibleHistory = historyLines.slice(
      Math.max(0, historyLines.length - availableBodyRows - state.scrollOffset),
      historyLines.length - state.scrollOffset,
    );
    const helpLines = wrapLines(rightPanelLines(state.screen, obs), rightWidth);

    const activeBorderColor = sc;
    const inactiveBorderColor = FG_STEEL;

    for (let row = 0; row < availableBodyRows; row += 1) {
      const leftContent = visibleHistory[row] ?? '';
      const rightContent = helpLines[row] ?? '';
      const left = themePadEnd(clip(leftContent, leftWidth - 1), leftWidth - 1);
      const right = themePadEnd(clip(rightContent, rightWidth - 1), rightWidth - 1);
      output.write(
        `${activeBorderColor}${BOX_BOLD.v}${RESET}${left} ${inactiveBorderColor}${BOX_BOLD.v}${RESET}${right}${inactiveBorderColor}${BOX_BOLD.v}${RESET}\n`,
      );
    }
  }

  // ── Bottom border ─────────────────────────────────────────────────────────
  output.write(
    `${FG_COPPER}${BOX_BOLD.bl}${leftBorder}${BOX_BOLD.tee_up}${rightBorder}${BOX_BOLD.br}${RESET}\n`,
  );
  output.write('\x1b[J'); // clear leftover lines below (handles resize shrink)
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamOutputToHistory(
  history: string[],
  text: string,
  render: (line?: string) => void,
): Promise<void> {
  const shouldAnimate = output.isTTY && text.length <= STREAM_ANIMATION_CHAR_LIMIT;
  if (!shouldAnimate) {
    pushHistory(history, text);
    render();
    return;
  }

  const lines = splitLines(text);
  for (const line of lines) {
    for (let i = 0; i < line.length; i += STREAM_CHUNK_CHARS) {
      render(line.slice(0, i + STREAM_CHUNK_CHARS));
      await delay(STREAM_FRAME_DELAY_MS);
    }
    pushHistory(history, line);
    render();
  }
  if (lines.length === 0) render();
}

function updateObservabilityFromResult(
  obs: Observability,
  result: {
    providerUsed: string;
    timingMs: number;
    trace?: { attempts: Array<{ viaFallback: boolean }> };
  },
): void {
  obs.requests += 1;
  obs.lastProvider = result.providerUsed;
  obs.recentTimingsMs.push(result.timingMs);
  if (obs.recentTimingsMs.length > MAX_TIMING_SAMPLES)
    obs.recentTimingsMs.splice(0, obs.recentTimingsMs.length - MAX_TIMING_SAMPLES);
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
    screen: 'dashboard',
    mode: 'normal',
    paletteInput: '',
    chatMessages: [],
    scrollOffset: 0,
  };
  const history: string[] = [];
  let leftWidth = Math.max(30, Math.floor((output.columns || 80) * 0.78));
  const observabilityPath = observabilityPathFromEnv(process.env);
  const previous = loadLatestSnapshot(observabilityPath);
  const observability: Observability = {
    requests: previous?.requests ?? 0,
    fallbackAttempts: previous?.fallbackAttempts ?? 0,
    totalAttempts: previous?.totalAttempts ?? 0,
    avgTimingMs: previous?.avgTimingMs ?? 0,
    recentTimingsMs: previous?.recentTimingsMs ?? [],
    lastProvider: previous?.lastProvider,
    lastError: previous?.lastError,
    lastHealthSummary: previous?.lastHealthSummary,
    lastPersistedTs: previous?.ts,
  };

  // Warn user about provider mode at startup
  if (options.chatProvider) {
    history.push(
      `${statusDot(true)} ${FG_WARM}provider${RESET} ${FG_COPPER}${options.chatProvider.name}${RESET} ${FG_STEEL}\u2502${RESET} ${FG_WARM}tools${RESET} ${FG_COPPER}${options.tools?.length ?? 0}${RESET}`,
    );
  } else {
    history.push(
      `${statusDot(false)} ${FG_OXIDE}No chat provider${RESET} ${FG_STEEL}\u2014 text-only fallback (no tools, no multi-turn)${RESET}`,
    );
    history.push(
      `${FG_COPPER_BRIGHT}  tip:${RESET} ${FG_WARM}Run${RESET} ${FG_COPPER}memphis init${RESET} ${FG_WARM}to configure a provider${RESET}`,
    );
  }

  let shouldExit = false;
  let refreshDashboardInFlight: Promise<void> | undefined;

  const persistObservability = () => {
    const ts = new Date().toISOString();
    appendSnapshot(observabilityPath, {
      ts,
      requests: observability.requests,
      fallbackAttempts: observability.fallbackAttempts,
      totalAttempts: observability.totalAttempts,
      avgTimingMs: observability.avgTimingMs,
      recentTimingsMs: observability.recentTimingsMs,
      lastProvider: observability.lastProvider,
      lastError: observability.lastError,
      lastHealthSummary: observability.lastHealthSummary,
    });
    observability.lastPersistedTs = ts;
  };

  let pendingLine: string | undefined;
  let renderTimer: NodeJS.Timeout | undefined;

  const renderNow = (line?: string) => {
    drawFullScreen(state, history, observability, leftWidth, line ?? pendingLine);
    pendingLine = undefined;
  };

  const render = (line?: string) => {
    if (line !== undefined) pendingLine = line;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderNow();
    }, RENDER_DEBOUNCE_MS);
  };

  const flushRender = (line?: string) => {
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    renderNow(line);
  };

  if (input.isTTY) {
    emitKeypressEvents(input);
    input.setRawMode?.(true);
  }

  const refreshDashboard = async () => {
    try {
      const next = await loadDashboardData();
      if (!equalDashboardData(state.dashboardData, next)) {
        state.dashboardData = next;
        if (state.screen === 'dashboard') render();
      }
    } catch (error) {
      pushHistory(
        history,
        `[dashboard] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const scheduleDashboardRefresh = () => {
    if (refreshDashboardInFlight) {
      return;
    }
    refreshDashboardInFlight = refreshDashboard().finally(() => {
      refreshDashboardInFlight = undefined;
    });
  };

  const setScreen = (next: TuiScreen, source: string) => {
    state.screen = next;
    state.scrollOffset = 0;
    pushHistory(history, source);
    render();
    if (next === 'dashboard') {
      scheduleDashboardRefresh();
    }
  };

  const onKeypress = (_str: string, key: { ctrl?: boolean; name?: string }) => {
    if (key.ctrl) {
      if (key.name === 'l') {
        pushHistory(history, '[keybind] screen redraw (Ctrl+L)');
        render();
        return;
      }

      if (key.name === 'k') {
        history.length = 0;
        state.scrollOffset = 0;
        pushHistory(history, '[keybind] history cleared (Ctrl+K)');
        render();
        return;
      }

      if (key.ctrl && key.name === 'p') {
        state.mode = state.mode === 'palette' ? 'normal' : 'palette';
        state.paletteInput = '';
        render();
        return;
      }

      if (key.ctrl && key.name === 'tab') {
        const screens: TuiScreen[] = ['dashboard', 'chat', 'health', 'embed', 'vault', 'decisions'];
        const idx = screens.indexOf(state.screen);
        state.screen = screens[(idx + 1) % screens.length];
        pushHistory(history, `[keybind] tab navigation to=${state.screen} (Ctrl+Tab)`);
        render();
        return;
      }

      if (key.ctrl && key.name === 'left') {
        leftWidth = Math.max(30, leftWidth - 2);
        render();
        return;
      }

      if (key.ctrl && key.name === 'right') {
        const termWidth = output.columns || 80;
        leftWidth = Math.min(termWidth - 30, leftWidth + 2);
        render();
        return;
      }

      const next = keybindToScreen(key.name);
      if (next) {
        setScreen(next, `[keybind] active screen=${next} (Ctrl+${key.name})`);
      }
      return;
    }

    // Palette mode handling
    if (state.mode === 'palette') {
      if (key.name === 'escape') {
        state.mode = 'normal';
        state.paletteInput = '';
        render();
        return;
      }

      if (key.name === 'enter') {
        // Execute first matching command
        const commands = [
          '/backup list', '/backup create',
          '/insights', '/connections scan', '/suggest',
          '/decisions list', '/decide',
          '/sync status', '/sync push',
          '/screen dashboard', '/screen chat', '/screen health', '/screen embed', '/screen vault',
          '/provider auto', '/provider ollama', '/provider shared-llm', '/provider local-fallback',
          '/strategy default', '/strategy latency-aware',
          '/model', '/vault init', '/vault add', '/vault get', '/vault list',
          '/embed reset', '/embed store', '/embed search',
          '/health', '/obs', '/obs export', '/obs reset',
          '/guide', '/help', '/exit',
        ];
        const filtered = state.paletteInput
          ? commands.filter((c) => c.toLowerCase().includes(state.paletteInput.toLowerCase()))
          : commands;
        if (filtered.length > 0) {
          const selectedCmd = filtered[0];
          state.mode = 'normal';
          state.paletteInput = '';
          pushHistory(history, `[palette] executing: ${selectedCmd}`);
          // Process the command as if typed
          if (selectedCmd === '/exit' || selectedCmd === '/quit') {
            shouldExit = true;
          } else if (selectedCmd.startsWith('/screen ')) {
            const screenName = selectedCmd.slice('/screen '.length);
            const next = normalizeScreen(screenName);
            if (next) setScreen(next, `ok: screen=${next}`);
          } else {
            // For other commands, push to history to process in main loop
            history.push(selectedCmd);
          }
          render();
        }
        return;
      }

      // Handle character input in palette mode
      if (_str && _str.length === 1) {
        state.paletteInput += _str;
        render();
        return;
      }

      // Backspace in palette mode
      if (key.name === 'backspace') {
        state.paletteInput = state.paletteInput.slice(0, -1);
        render();
        return;
      }

      return;
    }

    if (state.screen !== 'dashboard') {
      // Scrolling works on all screens for chat history
      if (key.name === 'pageup') {
        state.scrollOffset = Math.max(0, state.scrollOffset - 10);
        render();
        return;
      }

      if (key.name === 'pagedown') {
        state.scrollOffset += 10;
        render();
        return;
      }

      if (key.name === 'home') {
        state.scrollOffset = 0;
        render();
        return;
      }

      if (key.name === 'end') {
        const historyLines = wrapLines(history, leftWidth);
        state.scrollOffset = Math.max(0, historyLines.length - (output.rows || 24) - 6);
        render();
        return;
      }
      return;
    }

    if (key.name === 'j') {
      setScreen('vault', '[quick-action] journal');
      return;
    }

    if (key.name === 'a') {
      setScreen('chat', '[quick-action] ask');
      return;
    }

    if (key.name === 'r') {
      setScreen('embed', '[quick-action] recall');
      return;
    }

    if (key.name === 'q') {
      shouldExit = true;
      pushHistory(history, '[quick-action] quit');
      render();
    }
  };

  const onResize = () => {
    flushRender();
  };

  input.on('keypress', onKeypress);
  output.on('resize', onResize);
  if (previous) {
    pushHistory(history, `${FG_STEEL}\u2502 loaded snapshot from ${observabilityPath}${RESET}`);
  }
  pushHistory(
    history,
    `${FG_COPPER_BRIGHT}Memphis TUI${RESET} ${FG_STEEL}ready \u2014 type ${FG_COPPER}/help${RESET}${FG_STEEL} or ${FG_COPPER}/guide${RESET}${FG_STEEL}${RESET}`,
  );

  await refreshDashboard();
  const dashboardTimer = setInterval(() => {
    if (state.screen === 'dashboard') {
      scheduleDashboardRefresh();
    }
  }, 5000);

  try {
    while (true) {
      flushRender();
      const statusBar = renderStatusBar(state);
      if (statusBar) output.write(`${FG_STEEL}${statusBar}${RESET}\n`);
      const line = (await rl.question(`${FG_COPPER}\u276f${RESET} `)).trim();

      // In palette mode, input is handled via keypress events
      if (state.mode === 'palette') {
        // If user types something and presses enter in rl.question, ignore it in palette mode
        // The palette Enter handling is in onKeypress
        continue;
      }

      if (shouldExit) break;
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;

      if (line === '/help') {
        pushHistory(history, 'Help:');
        pushHistory(
          history,
          commandHelpLines()
            .map((x) => `  ${x}`)
            .join('\n'),
        );
        continue;
      }

      if (line === '/guide') {
        pushHistory(history, renderOperatorGuideLines(process.env).join('\n'));
        continue;
      }

      if (line === '/obs') {
        pushHistory(history, buildObservabilityPanelLines(observability).join('\n'));
        continue;
      }

      if (line === '/obs export' || line === '/obs export --json') {
        const entries = loadSnapshots(observabilityPath);
        if (line.endsWith('--json')) {
          pushHistory(
            history,
            JSON.stringify(
              { path: observabilityPath, entries: entries.length, latest: entries.at(-1) ?? null },
              null,
              2,
            ),
          );
        } else {
          pushHistory(history, `[obs] export path=${observabilityPath} entries=${entries.length}`);
        }
        continue;
      }

      if (line === '/obs reset') {
        resetSnapshots(observabilityPath);
        observability.requests = 0;
        observability.fallbackAttempts = 0;
        observability.totalAttempts = 0;
        observability.avgTimingMs = 0;
        observability.recentTimingsMs = [];
        observability.lastProvider = undefined;
        observability.lastError = undefined;
        observability.lastHealthSummary = undefined;
        observability.lastPersistedTs = undefined;
        pushHistory(history, `[obs] reset completed path=${observabilityPath}`);
        continue;
      }

      if (line === '/health') {
        const health = await renderHealthScreen(options.orchestration);
        observability.lastHealthSummary = splitLines(health)[0] ?? health;
        pushHistory(history, health);
        persistObservability();
        continue;
      }

      if (line.startsWith('/screen ')) {
        const next = normalizeScreen(line.slice('/screen '.length).trim());
        if (next) {
          setScreen(next, `ok: screen=${next}`);
        } else {
          pushHistory(history, 'error: usage /screen <chat|health|embed|vault|dashboard>');
        }
        continue;
      }

      if (line.startsWith('/provider ')) {
        const next = line.slice('/provider '.length).trim() as 'auto' | ProviderName;
        if (
          next === 'auto' ||
          next === 'ollama' ||
          next === 'shared-llm' ||
          next === 'decentralized-llm' ||
          next === 'local-fallback' ||
          next === 'glm' ||
          next === 'minimax' ||
          next === 'deepseek'
        ) {
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
        if (sub === 'init' && rest.length >= 3)
          pushHistory(history, runVaultInit(rest[0], rest[1], rest.slice(2).join(' ')));
        else if (sub === 'add' && rest.length >= 2)
          pushHistory(history, runVaultAdd(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'get' && rest.length >= 1) pushHistory(history, runVaultGet(rest[0]));
        else if (sub === 'list') pushHistory(history, runVaultList(rest[0]));
        else pushHistory(history, 'error: usage /vault init|add|get|list ...');
        continue;
      }

      if (line.startsWith('/embed ')) {
        const [, sub, ...rest] = line.split(' ');
        if (sub === 'reset') pushHistory(history, runEmbedReset());
        else if (sub === 'store' && rest.length >= 2)
          pushHistory(history, await embedStoreScreen(rest[0], rest.slice(1).join(' ')));
        else if (sub === 'search' && rest.length >= 1) {
          const query = rest[0];
          const topK = rest[1] ? Number(rest[1]) : 5;
          const tuned = rest[2] ? rest[2] === 'true' : false;
          pushHistory(history, embedSearchScreen(query, Number.isFinite(topK) ? topK : 5, tuned));
        } else pushHistory(history, 'error: usage /embed reset|store|search ...');
        continue;
      }

      if (line.startsWith('/decisions')) {
        const sub = line.slice('/decisions'.length).trim();
        if (sub === 'list' || sub === '') {
          const decisions = await loadDecisionsFromChain();
          if (decisions.length === 0) {
            pushHistory(history, 'No decisions recorded yet.');
          } else {
            for (const d of decisions) {
              pushHistory(history, `  ${d.hash} — ${d.question} → ${d.choice}`);
            }
            pushHistory(history, `${decisions.length} decision(s)`);
          }
        } else {
          pushHistory(history, 'error: usage /decisions list');
        }
        continue;
      }

      pushHistory(history, `${FG_WARM}\u276f ${line}${RESET}`);
      state.generatingSince = Date.now();
      state.lastStep = undefined;
      let frame = 0;
      const spinner = setInterval(() => {
        render(`${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${FG_STEEL}generating...${RESET}`);
        frame += 1;
      }, 80);

      try {
        if (options.chatProvider) {
          // Use real chat provider with multi-turn + tools
          const { runChatOnce } = await import('./screens/chat-screen.js');
          const chatOutput = await runChatOnce(
            {
              provider: options.chatProvider,
              model: state.model,
              systemPrompt: options.systemPrompt,
              tools: options.tools,
              toolExecutor: options.toolExecutor,
              messages: state.chatMessages,
            },
            line,
          );
          clearInterval(spinner);
          state.generatingSince = undefined;
          // Update observability with basic info
          observability.requests += 1;
          observability.lastProvider = options.chatProvider.name;
          observability.lastError = undefined;
          persistObservability();
          await streamOutputToHistory(history, chatOutput, render);
        } else {
          // Fallback: use orchestration.generate (text-in/text-out)
          const result = await options.orchestration.generate({
            input: line,
            provider: state.provider,
            model: state.model,
            strategy: state.strategy,
          });

          clearInterval(spinner);
          state.generatingSince = undefined;
          state.lastStep = result.trace?.attempts?.length ?? 1;
          updateObservabilityFromResult(observability, result);
          observability.lastError = undefined;
          persistObservability();

          const chunks = [
            `[provider=${result.providerUsed} model=${result.modelUsed ?? 'n/a'} timing=${result.timingMs}ms]`,
            result.output,
          ];
          if (result.trace) {
            chunks.push('trace:');
            for (const a of result.trace.attempts) {
              chunks.push(
                `  - #${a.attempt} ${a.provider} ${a.viaFallback ? '(fallback)' : '(primary)'} ${a.latencyMs}ms ${a.ok ? 'ok' : `err=${a.errorCode ?? 'unknown'}`}`,
              );
            }
          }

          await streamOutputToHistory(history, chunks.join('\n'), render);
        }
      } catch (error) {
        clearInterval(spinner);
        state.generatingSince = undefined;
        observability.lastError = error instanceof Error ? error.message : String(error);
        persistObservability();
        pushHistory(history, `error: ${observability.lastError}`);
      }
    }
  } finally {
    if (renderTimer) clearTimeout(renderTimer);
    if (dashboardTimer) clearInterval(dashboardTimer);
    output.off('resize', onResize);
    input.off('keypress', onKeypress);
    if (input.isTTY) input.setRawMode?.(false);
    output.write('\x1b[2J\x1b[H');
    rl.close();
  }
}
