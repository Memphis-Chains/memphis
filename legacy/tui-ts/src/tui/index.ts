import { renderAnsi } from './ansi-renderer.js';
import type { SessionRecord, SessionRepository } from '../core/contracts/repository.js';
import type { ProviderName } from '../core/types.js';
import type { ChatMessage, ChatToolDefinition, ChatToolCall } from '../providers/index.js';
import type { RuntimeProvider } from '../providers/runtime.js';
import { listVaultEntryMetadata } from '../security/vault-boundary.js';
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
  createProcessTerminalIO,
  type TerminalIO,
  type TuiKeypress,
} from './io.js';
import {
  clampLeftWidth,
  resolveSplitPanelLayout,
  sliceVisibleLines,
} from './layout-math.js';
import {
  appendSnapshot,
  loadLatestSnapshot,
  loadSnapshots,
  observabilityPathFromEnv,
  resetSnapshots,
} from './observability-store.js';
import { RootLayout, formatStatusLine } from './RootLayout.js';
import { renderOperatorGuideLines } from '../infra/operator-guide.js';
import { renderDashboardScreen } from './screens/DashboardScreen.js';
import { loadDecisionsFromChain } from './screens/decision-screen.js';
import { embedSearchScreen, embedStoreScreen } from './screens/embed-screen.js';
import { renderHealthScreen } from './screens/health-screen.js';
import { renderSessionScreen } from './screens/session-screen.js';
import { ProcessTerminal } from './terminal.js';
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
  sessionRepository?: SessionRepository;
  provider?: 'auto' | ProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
  /** Chat provider for real LLM conversations (Provider.chat interface) */
  chatProvider?: RuntimeProvider;
  /** System prompt for chat conversations */
  systemPrompt?: string;
  /** MCP tool definitions available to the chat provider */
  tools?: ChatToolDefinition[];
  /** Executor for MCP tool calls */
  toolExecutor?: (call: ChatToolCall) => Promise<string>;
};

export type TuiState = {
  provider: 'auto' | ProviderName;
  strategy: 'default' | 'latency-aware';
  model?: string;
  dashboardData?: DashboardData;
  screenLines: Partial<Record<TuiScreen, string[]>>;
  sessionRecords: SessionRecord[];
  chatMessages: ChatMessage[];
  generatingSince?: number;
  lastStep?: number;
};

export type Observability = {
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
  `${FG_COPPER}/health${RESET}             ${FG_STEEL}refresh system status${RESET}`,
  `${FG_COPPER}/obs${RESET}                ${FG_STEEL}observability${RESET}`,
  `${FG_COPPER}/screen${RESET} ${FG_WARM}<name>${RESET}      ${FG_STEEL}switch screen${RESET}`,
  `${FG_COPPER}/provider${RESET} ${FG_WARM}<name>${RESET}    ${FG_STEEL}set provider${RESET}`,
  `${FG_COPPER}/strategy${RESET} ${FG_WARM}<type>${RESET}    ${FG_STEEL}routing mode${RESET}`,
  `${FG_COPPER}/model${RESET} ${FG_WARM}<id>${RESET}         ${FG_STEEL}set model${RESET}`,
  `${FG_COPPER}/vault${RESET} ${FG_WARM}<cmd>${RESET}        ${FG_STEEL}vault ops${RESET}`,
  `${FG_COPPER}/embed${RESET} ${FG_WARM}<cmd>${RESET}        ${FG_STEEL}memory index ops${RESET}`,
  `${FG_COPPER}/cases${RESET} ${FG_WARM}list${RESET}         ${FG_STEEL}cases / decisions${RESET}`,
  `${DIM}anything else => chat prompt${RESET}`,
  '',
  `${FG_STEEL}Ctrl+1..7${RESET} ${DIM}switch screen${RESET}`,
  `${FG_STEEL}Ctrl+L${RESET}    ${DIM}redraw${RESET}  ${FG_STEEL}Ctrl+K${RESET} ${DIM}clear${RESET}`,
  `${FG_STEEL}Ctrl+P${RESET}    ${DIM}command palette${RESET}  ${FG_STEEL}Ctrl+Tab${RESET} ${DIM}next tab${RESET}`,
] as const;

function commandHelpLines(): string[] {
  return [...COMMAND_HELP_LINES];
}

function renderTabBar(screen: TuiScreen): string {
  const tabs: TuiScreen[] = ['overview', 'chat', 'memory', 'sessions', 'vault', 'cases', 'system'];
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
  if (screen === 'system') return FG_TEAL;
  if (screen === 'memory') return FG_EMBED;
  if (screen === 'vault') return FG_VAULT;
  return FG_CHAIN;
}

function titleCase(screen: TuiScreen): string {
  if (screen === 'cases') return 'Cases / Decisions';
  return `${screen.charAt(0).toUpperCase()}${screen.slice(1)}`;
}

function loadingScreenLines(screen: TuiScreen): string[] {
  return [
    `${FG_COPPER_BRIGHT}${BOLD}${titleCase(screen)}${RESET}`,
    `${FG_STEEL}Loading ${screen} data...${RESET}`,
  ];
}

function buildMemoryScreenLines(dashboardData?: DashboardData): string[] {
  if (!dashboardData) {
    return loadingScreenLines('memory');
  }

  return [
    `${FG_EMBED}${BOLD}Memory${RESET}`,
    `${FG_STEEL}Embeddings${RESET} ${FG_WHITE}${dashboardData.stats.embeddingCount}${RESET}`,
    `${FG_STEEL}Topics${RESET} ${FG_WARM}${dashboardData.insights.topTopics.join(', ')}${RESET}`,
    `${FG_STEEL}Patterns${RESET} ${FG_WHITE}${dashboardData.insights.patternsLoaded}${RESET}`,
    `${FG_STEEL}Learning accuracy${RESET} ${FG_WHITE}${Math.round(
      dashboardData.insights.learningAccuracy * 100,
    )}%${RESET}`,
    `${FG_STEEL}Suggestions pending${RESET} ${FG_WHITE}${dashboardData.insights.suggestionsPending}${RESET}`,
    '',
    `${FG_COPPER}/embed store${RESET} ${FG_WARM}<id> <value>${RESET}`,
    `${FG_COPPER}/embed search${RESET} ${FG_WARM}<query> [topK]${RESET}`,
    `${FG_COPPER}/embed reset${RESET}`,
  ];
}

function buildVaultScreenLines(): string[] {
  const entries = listVaultEntryMetadata(
    { surface: 'tui', command: 'screen vault' },
    process.env,
    undefined,
    { latestPerKey: true },
  );

  if (entries.length === 0) {
    return [
      `${FG_VAULT}${BOLD}Vault${RESET}`,
      'No vault entries stored yet.',
      `${FG_COPPER}/vault init${RESET} ${FG_WARM}<pass> <question> <answer>${RESET}`,
      `${FG_COPPER}/vault add${RESET} ${FG_WARM}<key> <value>${RESET}`,
    ];
  }

  return [
    `${FG_VAULT}${BOLD}Vault${RESET}`,
    `${FG_STEEL}Latest entries per key${RESET} ${FG_WHITE}(${entries.length})${RESET}`,
    ...entries.map(
      (entry) =>
        `  ${FG_WARM}${entry.key}${RESET} ${FG_STEEL}${entry.createdAt}${RESET} integrity=${entry.integrityOk}`,
    ),
  ];
}

function buildCasesScreenLines(decisions: Awaited<ReturnType<typeof loadDecisionsFromChain>>): string[] {
  if (decisions.length === 0) {
    return [
      `${FG_CHAIN}${BOLD}Cases / Decisions${RESET}`,
      'No decisions recorded yet.',
      `${FG_COPPER}/cases list${RESET}`,
    ];
  }

  return [
    `${FG_CHAIN}${BOLD}Cases / Decisions${RESET}`,
    `${FG_STEEL}Decision history${RESET} ${FG_WHITE}(${decisions.length})${RESET}`,
    ...decisions.map(
      (decision) => `  ${FG_WARM}${decision.hash}${RESET} ${decision.question} -> ${decision.choice}`,
    ),
  ];
}

function buildSystemScreenLines(healthLines: string[], obs: Observability): string[] {
  return [
    `${FG_TEAL}${BOLD}System${RESET}`,
    ...healthLines,
    '',
    ...buildObservabilityPanelLines(obs),
  ];
}

function buildSystemErrorLines(message: string, obs: Observability): string[] {
  return [
    `${FG_TEAL}${BOLD}System${RESET}`,
    `${FG_OXIDE}Provider health unavailable:${RESET} ${message}`,
    '',
    ...buildObservabilityPanelLines(obs),
  ];
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
  if (screen === 'system')
    return [
      header,
      `${FG_COPPER}/health${RESET}         ${FG_STEEL}refresh${RESET}`,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}overview${RESET} ${FG_STEEL}back to overview${RESET}`,
      `${DIM}chat still works from input${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  if (screen === 'memory') {
    return [
      header,
      `${FG_COPPER}/embed reset${RESET}`,
      `${FG_COPPER}/embed store${RESET} ${FG_WARM}<id> <val>${RESET}`,
      `${FG_COPPER}/embed search${RESET} ${FG_WARM}<q> [topK]${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  if (screen === 'overview') {
    return [
      header,
      `${FG_COPPER_BRIGHT}C${RESET}${FG_STEEL}hat${RESET}  ${FG_COPPER_BRIGHT}M${RESET}${FG_STEEL}emory${RESET}  ${FG_COPPER_BRIGHT}V${RESET}${FG_STEEL}ault${RESET}  ${FG_COPPER_BRIGHT}Q${RESET}${FG_STEEL}uit${RESET}`,
      `${DIM}auto refresh: 5s${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  if (screen === 'cases') {
    return [
      header,
      `${FG_COPPER}/cases list${RESET}`,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}chat${RESET}   ${FG_STEEL}back to chat${RESET}`,
      `${DIM}records from decision-history.jsonl${RESET}`,
      sep,
      ...buildObservabilityPanelLines(obs),
    ];
  }
  if (screen === 'sessions') {
    return [
      header,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}chat${RESET}   ${FG_STEEL}back to chat${RESET}`,
      `${FG_COPPER}/screen${RESET} ${FG_WARM}system${RESET} ${FG_STEEL}runtime status${RESET}`,
      `${DIM}sessions are loaded from the runtime repository${RESET}`,
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

function getContentLines(
  layout: RootLayout,
  state: TuiState,
  history: string[],
  leftWidth: number,
  liveLine?: string,
): string[] {
  if (layout.screen === 'overview' && state.dashboardData) {
    return renderDashboardScreen(state.dashboardData, leftWidth);
  }
  if (layout.screen === 'chat') {
    return wrapLines(liveLine ? [...history, liveLine] : history, leftWidth);
  }
  return wrapLines(state.screenLines[layout.screen] ?? loadingScreenLines(layout.screen), leftWidth);
}

function buildScreenLines(
  layout: RootLayout,
  state: TuiState,
  history: string[],
  obs: Observability,
  termWidth: number,
  termHeight: number,
  leftWidth: number,
  liveLine?: string,
): string[] {
  const lines: string[] = [];
  const push = (s: string) => lines.push(s);

  const {
    leftWidth: resolvedLeftWidth,
    rightWidth,
    availableBodyRows,
  } = resolveSplitPanelLayout(termWidth, termHeight, leftWidth);

  // ── Tab bar ───────────────────────────────────────────────────────────────
  push(`${FG_STEEL}${renderTabBar(layout.screen)}${RESET}`);

  // ── Header ────────────────────────────────────────────────────────────────
  const sc = screenColor(layout.screen);
  const headerLeft = `${MEMPHIS_LOGO_COMPACT} ${FG_STEEL}${BOX.v}${RESET} ${sc}${BOLD}${layout.screen.toUpperCase()}${RESET}`;
  const headerRight = formatObservabilityLine(obs);
  const headerGap = Math.max(
    1,
    termWidth - visualLength(headerLeft) - visualLength(headerRight) - 1,
  );
  push(`${headerLeft}${' '.repeat(headerGap)}${headerRight}`);

  // ── Status line ───────────────────────────────────────────────────────────
  push(formatStatusLine(layout.screen, state.provider, state.strategy, state.model, layout.scrollOffset, termWidth));

  // ── Top border ────────────────────────────────────────────────────────────
  const borderH = BOX_BOLD.h;
  const leftBorder = borderH.repeat(resolvedLeftWidth);
  const rightBorder = borderH.repeat(rightWidth);
  push(`${FG_COPPER}${BOX_BOLD.tl}${leftBorder}${BOX_BOLD.tee_down}${rightBorder}${BOX_BOLD.tr}${RESET}`);

  // ── Body ──────────────────────────────────────────────────────────────────
  if (layout.mode === 'palette') {
    // Palette mode - show command list with fuzzy filter
    const commands = [
      '/backup list', '/backup create',
      '/insights', '/connections scan', '/suggest',
      '/cases list', '/decide',
      '/sync status', '/sync push',
      '/screen overview', '/screen chat', '/screen memory', '/screen sessions',
      '/screen vault', '/screen cases', '/screen system',
      '/provider auto', '/provider ollama', '/provider shared-llm', '/provider local-fallback',
      '/strategy default', '/strategy latency-aware',
      '/model', '/vault init', '/vault add', '/vault get', '/vault list',
      '/embed reset', '/embed store', '/embed search',
      '/health', '/obs', '/obs export', '/obs reset',
      '/guide', '/help', '/exit',
    ];
    const filtered = layout.paletteInput
      ? commands.filter((c) => c.toLowerCase().includes(layout.paletteInput.toLowerCase()))
      : commands;

    for (let row = 0; row < availableBodyRows; row += 1) {
      const cmd = filtered[row] ?? '';
      const leftContent = cmd;
      const rightContent = '';
      const left = themePadEnd(clip(leftContent, resolvedLeftWidth - 1), resolvedLeftWidth - 1);
      const right = themePadEnd(clip(rightContent, rightWidth - 1), rightWidth - 1);
      push(
        `${FG_COPPER}${BOX_BOLD.v}${RESET}${left} ${FG_STEEL}${BOX_BOLD.v}${RESET}${right}${FG_STEEL}${BOX_BOLD.v}${RESET}`,
      );
    }
  } else {
    const historyLines = getContentLines(layout, state, history, resolvedLeftWidth, liveLine);
    layout.clampScroll(historyLines.length, availableBodyRows);
    const visibleHistory = sliceVisibleLines(historyLines, availableBodyRows, layout.scrollOffset);
    const helpLines = wrapLines(rightPanelLines(layout.screen, obs), rightWidth);

    const activeBorderColor = sc;
    const inactiveBorderColor = FG_STEEL;

    for (let row = 0; row < availableBodyRows; row += 1) {
      const leftContent = visibleHistory[row] ?? '';
      const rightContent = helpLines[row] ?? '';
      const left = themePadEnd(clip(leftContent, resolvedLeftWidth - 1), resolvedLeftWidth - 1);
      const right = themePadEnd(clip(rightContent, rightWidth - 1), rightWidth - 1);
      push(
        `${activeBorderColor}${BOX_BOLD.v}${RESET}${left} ${inactiveBorderColor}${BOX_BOLD.v}${RESET}${right}${inactiveBorderColor}${BOX_BOLD.v}${RESET}`,
      );
    }
  }

  // ── Bottom border ─────────────────────────────────────────────────────────
  push(`${FG_COPPER}${BOX_BOLD.bl}${leftBorder}${BOX_BOLD.tee_up}${rightBorder}${BOX_BOLD.br}${RESET}`);

  return lines;
}


async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamOutputToHistory(
  history: string[],
  text: string,
  render: (line?: string) => void,
  animate: boolean,
): Promise<void> {
  const shouldAnimate = animate && text.length <= STREAM_ANIMATION_CHAR_LIMIT;
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

export type TuiCommandResult = 'handled' | 'unhandled' | 'exit';

type TuiCommandContext = {
  state: TuiState;
  observability: Observability;
  observabilityPath: string;
  orchestration: OrchestrationService;
  setScreen: (next: TuiScreen, source: string) => void;
  pushHistory: (value: string) => void;
  persistObservability: () => void;
  loadGuideLines: () => string[];
  refreshScreen?: (screen: TuiScreen) => Promise<void> | void;
};

export async function handleTuiCommand(
  line: string,
  context: TuiCommandContext,
): Promise<TuiCommandResult> {
  const { state, observability, observabilityPath, orchestration, setScreen, pushHistory } = context;

  if (line === '/exit' || line === '/quit') {
    return 'exit';
  }

  if (line === '/help') {
    pushHistory('Help:');
    pushHistory(
      commandHelpLines()
        .map((value) => `  ${value}`)
        .join('\n'),
    );
    return 'handled';
  }

  if (line === '/guide') {
    pushHistory(context.loadGuideLines().join('\n'));
    return 'handled';
  }

  if (line === '/obs') {
    pushHistory(buildObservabilityPanelLines(observability).join('\n'));
    return 'handled';
  }

  if (line === '/obs export' || line === '/obs export --json') {
    const entries = loadSnapshots(observabilityPath);
    if (line.endsWith('--json')) {
      pushHistory(
        JSON.stringify(
          { path: observabilityPath, entries: entries.length, latest: entries.at(-1) ?? null },
          null,
          2,
        ),
      );
    } else {
      pushHistory(`[obs] export path=${observabilityPath} entries=${entries.length}`);
    }
    return 'handled';
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
    pushHistory(`[obs] reset completed path=${observabilityPath}`);
    return 'handled';
  }

  if (line === '/health') {
    const health = await renderHealthScreen(orchestration);
    observability.lastHealthSummary = splitLines(health)[0] ?? health;
    state.screenLines.system = buildSystemScreenLines(splitLines(health), observability);
    pushHistory(health);
    await context.refreshScreen?.('system');
    context.persistObservability();
    return 'handled';
  }

  if (line.startsWith('/screen ')) {
    const next = normalizeScreen(line.slice('/screen '.length).trim());
    if (next) {
      setScreen(next, `ok: screen=${next}`);
    } else {
      pushHistory('error: usage /screen <overview|chat|memory|sessions|vault|cases|system>');
    }
    return 'handled';
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
      pushHistory(`ok: provider=${next}`);
    } else {
      pushHistory(`error: unsupported provider=${next}`);
    }
    return 'handled';
  }

  if (line.startsWith('/strategy ')) {
    const next = line.slice('/strategy '.length).trim() as 'default' | 'latency-aware';
    if (next === 'default' || next === 'latency-aware') {
      state.strategy = next;
      pushHistory(`ok: strategy=${next}`);
    } else {
      pushHistory(`error: unsupported strategy=${next}`);
    }
    return 'handled';
  }

  if (line.startsWith('/model ')) {
    state.model = line.slice('/model '.length).trim();
    pushHistory(`ok: model=${state.model}`);
    return 'handled';
  }

  if (line.startsWith('/vault ')) {
    const [cmd, sub, ...rest] = line.split(' ');
    void cmd;
    if (sub === 'init' && rest.length >= 3) {
      pushHistory(runVaultInit(rest[0], rest[1], rest.slice(2).join(' ')));
    } else if (sub === 'add' && rest.length >= 2) {
      pushHistory(runVaultAdd(rest[0], rest.slice(1).join(' ')));
    } else if (sub === 'get' && rest.length >= 1) {
      pushHistory(runVaultGet(rest[0]));
    } else if (sub === 'list') {
      pushHistory(runVaultList(rest[0]));
    } else {
      pushHistory('error: usage /vault init|add|get|list ...');
    }
    await context.refreshScreen?.('vault');
    return 'handled';
  }

  if (line.startsWith('/embed ')) {
    const [, sub, ...rest] = line.split(' ');
    if (sub === 'reset') {
      pushHistory(runEmbedReset());
    } else if (sub === 'store' && rest.length >= 2) {
      pushHistory(await embedStoreScreen(rest[0], rest.slice(1).join(' ')));
    } else if (sub === 'search' && rest.length >= 1) {
      const query = rest[0];
      const topK = rest[1] ? Number(rest[1]) : 5;
      const tuned = rest[2] ? rest[2] === 'true' : false;
      pushHistory(embedSearchScreen(query, Number.isFinite(topK) ? topK : 5, tuned));
    } else {
      pushHistory('error: usage /embed reset|store|search ...');
    }
    await context.refreshScreen?.('memory');
    return 'handled';
  }

  if (line.startsWith('/cases') || line.startsWith('/decisions')) {
    const prefix = line.startsWith('/cases') ? '/cases' : '/decisions';
    const sub = line.slice(prefix.length).trim();
    if (sub === 'list' || sub === '') {
      const decisions = await loadDecisionsFromChain();
      state.screenLines.cases = buildCasesScreenLines(decisions);
      if (decisions.length === 0) {
        pushHistory('No decisions recorded yet.');
      } else {
        for (const decision of decisions) {
          pushHistory(`  ${decision.hash} — ${decision.question} → ${decision.choice}`);
        }
        pushHistory(`${decisions.length} decision(s)`);
      }
    } else {
      pushHistory('error: usage /cases list');
    }
    await context.refreshScreen?.('cases');
    return 'handled';
  }

  return 'unhandled';
}

export async function runTuiApp(options: TuiOptions, io: TerminalIO = createProcessTerminalIO()): Promise<void> {
  const { input, output, lineReader } = io;
  // RootLayout owns screen/mode/palette/scroll state
  const layout = new RootLayout();
  const state: TuiState = {
    provider: options.provider ?? 'auto',
    strategy: options.strategy ?? 'default',
    model: options.model,
    dashboardData: undefined,
    screenLines: {
      memory: loadingScreenLines('memory'),
      sessions: loadingScreenLines('sessions'),
      vault: loadingScreenLines('vault'),
      cases: loadingScreenLines('cases'),
      system: loadingScreenLines('system'),
    },
    sessionRecords: [],
    chatMessages: [],
    generatingSince: undefined,
    lastStep: undefined,
  };
  const history: string[] = [];
  let leftWidth = clampLeftWidth(output.columns || 80, Math.floor((output.columns || 80) * 0.78));
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

  // ProcessTerminal handles line-level diffing and CSI 2026 sync brackets
  const terminal = new ProcessTerminal(output);

  const appendHistory = (value: string) => {
    pushHistory(history, value);
  };

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

  const resolveViewport = (line?: string) => {
    const viewport = resolveSplitPanelLayout(output.columns, output.rows, leftWidth);
    leftWidth = viewport.leftWidth;
    const contentLines = getContentLines(layout, state, history, leftWidth, line);
    return { viewport, contentLines };
  };

  // Line diffing eliminates flicker, so debounce is no longer needed
  const renderNow = (line?: string) => {
    const { viewport, contentLines } = resolveViewport(line ?? pendingLine);
    layout.clampScroll(contentLines.length, viewport.availableBodyRows);
    const lines = buildScreenLines(
      layout,
      state,
      history,
      observability,
      output.columns,
      output.rows,
      leftWidth,
      line ?? pendingLine,
    );
    terminal.write(lines);
    pendingLine = undefined;
  };

  const render = (line?: string) => {
    if (line !== undefined) pendingLine = line;
    // No debounce — ProcessTerminal's line diffing handles flicker-free output
    renderNow();
  };

  const flushRender = (line?: string) => {
    renderNow(line);
  };

  if (input.isTTY) {
    input.enableRawMode();
  }

  const refreshDashboard = async () => {
    try {
      const next = await loadDashboardData();
      if (!equalDashboardData(state.dashboardData, next)) {
        state.dashboardData = next;
        state.screenLines.memory = buildMemoryScreenLines(next);
        if (layout.screen === 'overview' || layout.screen === 'memory') render();
      }
    } catch (error) {
      appendHistory(
        `[overview] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const refreshScreenData = async (screen: TuiScreen): Promise<void> => {
    if (screen === 'chat' || screen === 'overview') {
      if (screen === 'overview') {
        await refreshDashboard();
      }
      return;
    }

    if (screen === 'memory') {
      await refreshDashboard();
      state.screenLines.memory = buildMemoryScreenLines(state.dashboardData);
      return;
    }

    if (screen === 'sessions') {
      if (!options.sessionRepository) {
        state.sessionRecords = [];
        state.screenLines.sessions = [
          `${FG_CHAIN}${BOLD}Sessions${RESET}`,
          'Session repository unavailable in this runtime.',
        ];
        return;
      }
      const records = options.sessionRepository?.listSessions() ?? [];
      state.sessionRecords = records;
      state.screenLines.sessions = renderSessionScreen(records);
      return;
    }

    if (screen === 'vault') {
      state.screenLines.vault = buildVaultScreenLines();
      return;
    }

    if (screen === 'cases') {
      const decisions = await loadDecisionsFromChain();
      state.screenLines.cases = buildCasesScreenLines(decisions);
      return;
    }

    try {
      const health = await renderHealthScreen(options.orchestration);
      observability.lastHealthSummary = splitLines(health)[0] ?? health;
      state.screenLines.system = buildSystemScreenLines(splitLines(health), observability);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      observability.lastHealthSummary = 'unavailable';
      state.screenLines.system = buildSystemErrorLines(message, observability);
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
    layout.setScreen(next);
    appendHistory(source);
    render();
    if (next === 'overview') scheduleDashboardRefresh();
    void refreshScreenData(next)
      .then(() => {
        if (layout.screen === next) render();
      })
      .catch((error) => {
        appendHistory(
          `[screen] ${next} refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (layout.screen === next) render();
      });
  };

  const onKeypress = (_str: string, key: TuiKeypress) => {
    if (key.ctrl) {
      if (key.name === 'l') {
        appendHistory('[keybind] screen redraw (Ctrl+L)');
        render();
        return;
      }

      if (key.name === 'k') {
        history.length = 0;
        layout.scrollToLatest();
        appendHistory('[keybind] history cleared (Ctrl+K)');
        render();
        return;
      }

      if (key.ctrl && key.name === 'p') {
        layout.togglePalette();
        render();
        return;
      }

      if (key.ctrl && key.name === 'tab') {
        layout.nextScreen();
        appendHistory(`[keybind] tab navigation to=${layout.screen} (Ctrl+Tab)`);
        render();
        return;
      }

      if (key.ctrl && key.name === 'left') {
        leftWidth = clampLeftWidth(output.columns || 80, leftWidth - 2);
        render();
        return;
      }

      if (key.ctrl && key.name === 'right') {
        leftWidth = clampLeftWidth(output.columns || 80, leftWidth + 2);
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
    if (layout.mode === 'palette') {
      if (key.name === 'escape') {
        layout.closePalette();
        render();
        return;
      }

      if (key.name === 'enter') {
        // Execute first matching command
        const commands = [
          '/backup list', '/backup create',
          '/insights', '/connections scan', '/suggest',
          '/cases list', '/decide',
          '/sync status', '/sync push',
          '/screen overview', '/screen chat', '/screen memory', '/screen sessions',
          '/screen vault', '/screen cases', '/screen system',
          '/provider auto', '/provider ollama', '/provider shared-llm', '/provider local-fallback',
          '/strategy default', '/strategy latency-aware',
          '/model', '/vault init', '/vault add', '/vault get', '/vault list',
          '/embed reset', '/embed store', '/embed search',
          '/health', '/obs', '/obs export', '/obs reset',
          '/guide', '/help', '/exit',
        ];
        const filtered = layout.paletteInput
          ? commands.filter((c) => c.toLowerCase().includes(layout.paletteInput.toLowerCase()))
          : commands;
        if (filtered.length > 0) {
          const selectedCmd = filtered[0];
          layout.closePalette();
          appendHistory(`[palette] executing: ${selectedCmd}`);
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
        layout.appendPaletteInput(_str);
        render();
        return;
      }

      // Backspace in palette mode
      if (key.name === 'backspace') {
        layout.backspacePaletteInput();
        render();
        return;
      }

      return;
    }

    if (key.name === 'pageup' || key.name === 'pagedown' || key.name === 'home' || key.name === 'end') {
      const { viewport, contentLines } = resolveViewport();

      if (key.name === 'pageup') {
        layout.scrollOlder(contentLines.length, viewport.availableBodyRows, 10);
        render();
        return;
      }

      if (key.name === 'pagedown') {
        layout.scrollNewer(10);
        render();
        return;
      }

      if (key.name === 'home') {
        layout.scrollToOldest(contentLines.length, viewport.availableBodyRows);
        render();
        return;
      }

      layout.scrollToLatest();
      render();
      return;
    }

    if (layout.screen === 'overview') {
      if (key.name === 'v' || key.name === 'j') {
        setScreen('vault', '[quick-action] vault');
        return;
      }

      if (key.name === 'c' || key.name === 'a') {
        setScreen('chat', '[quick-action] ask');
        return;
      }

      if (key.name === 'm' || key.name === 'r') {
        setScreen('memory', '[quick-action] memory');
        return;
      }

      if (key.name === 'q') {
        shouldExit = true;
        appendHistory('[quick-action] quit');
        render();
      }
    }
  };

  const onResize = () => {
    leftWidth = clampLeftWidth(output.columns || 80, leftWidth);
    terminal.onResize();
    flushRender();
  };

  input.onKeypress(onKeypress);
  output.onResize(onResize);
  if (previous) {
    appendHistory(`${FG_STEEL}\u2502 loaded snapshot from ${observabilityPath}${RESET}`);
  }
  appendHistory(
    `${FG_COPPER_BRIGHT}Memphis TUI${RESET} ${FG_STEEL}ready \u2014 type ${FG_COPPER}/help${RESET}${FG_STEEL} or ${FG_COPPER}/guide${RESET}${FG_STEEL}${RESET}`,
  );

  await refreshDashboard();
  await refreshScreenData('system');
  await refreshScreenData('sessions');
  await refreshScreenData('vault');
  await refreshScreenData('cases');
  const dashboardTimer = setInterval(() => {
    if (layout.screen === 'overview') {
      scheduleDashboardRefresh();
    }
  }, 5000);

  try {
    while (true) {
      flushRender();
      const statusBar = renderStatusBar(state);
      if (statusBar) output.write(`${FG_STEEL}${statusBar}${RESET}\n`);
      const line = (await lineReader.question(`${FG_COPPER}\u276f${RESET} `)).trim();

      // In palette mode, input is handled via keypress events
      if (layout.mode === 'palette') {
        // If user types something and presses enter in rl.question, ignore it in palette mode
        // The palette Enter handling is in onKeypress
        continue;
      }

      if (shouldExit) break;
      if (!line) continue;
      const commandResult = await handleTuiCommand(line, {
        state,
        observability,
        observabilityPath,
        orchestration: options.orchestration,
        setScreen,
        pushHistory: appendHistory,
        persistObservability,
        loadGuideLines: () => renderOperatorGuideLines(process.env),
        refreshScreen: refreshScreenData,
      });
      if (commandResult === 'exit') {
        break;
      }
      if (commandResult === 'handled') {
        continue;
      }

      appendHistory(`${FG_WARM}\u276f ${line}${RESET}`);
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
          await streamOutputToHistory(history, renderAnsi(chatOutput), render, output.isTTY);
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

          await streamOutputToHistory(history, renderAnsi(chunks.join('\n')), render, output.isTTY);
        }
      } catch (error) {
        clearInterval(spinner);
        state.generatingSince = undefined;
        observability.lastError = error instanceof Error ? error.message : String(error);
        persistObservability();
        appendHistory(`error: ${observability.lastError}`);
      }
    }
  } finally {
    if (dashboardTimer) clearInterval(dashboardTimer);
    output.offResize(onResize);
    input.offKeypress(onKeypress);
    input.disableRawMode();
    terminal.clearScreen();
    lineReader.close();
  }
}
