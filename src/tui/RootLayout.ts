/**
 * RootLayout — Root TUI layout component.
 *
 * Manages:
 * - Current screen (dashboard, chat, health, embed, vault, decisions)
 * - Command palette mode
 * - Panel scroll offsets
 *
 * Renders:
 * - Tab bar, header, status line, borders (chrome)
 * - Delegates body content to the appropriate screen renderer
 *
 * Does NOT manage:
 * - Command routing (stays in runTuiApp via readline)
 * - Chat history (managed in runTuiApp)
 * - Observability state (passed as argument to render)
 */

import { stdout as output } from 'node:process';

import type { Component, MemphisKey } from './component.js';
import type { TuiScreen } from './core.js';
import { renderDashboardScreen } from './screens/DashboardScreen.js';
import {
  BOLD,
  BOX_BOLD,
  FG_CHAIN,
  FG_COPPER,
  FG_COPPER_BRIGHT,
  FG_EMBED,
  FG_STEEL,
  FG_TEAL,
  FG_VAULT,
  FG_WARM,
  MEMPHIS_LOGO_COMPACT,
  RESET,
  clip as themeClip,
  padEnd as themePadEnd,
  visualLength,
} from './theme.js';

export type LayoutRenderOptions = {
  history: string[];
  obs: Observability;
  leftWidth: number;
  liveLine?: string;
  scrollOffset: number;
  availableBodyRows: number;
  provider: string;
  strategy: string;
  model?: string;
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

const SCREENS: TuiScreen[] = ['dashboard', 'chat', 'health', 'embed', 'vault', 'decisions'];

function screenColor(screen: TuiScreen): string {
  if (screen === 'chat') return FG_COPPER_BRIGHT;
  if (screen === 'health') return FG_TEAL;
  if (screen === 'embed') return FG_EMBED;
  if (screen === 'vault') return FG_VAULT;
  return FG_CHAIN;
}

function renderTabBar(screen: TuiScreen): string {
  return SCREENS.map((t) => (t === screen ? `[${t.toUpperCase()}]` : ` ${t} `)).join(' ');
}

function wrapLine(value: string, width: number): string[] {
  if (width <= 0) return [''];
  const vlen = visualLength(value);
  if (vlen <= width) return [value];
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/\x1b\[[0-9;]*m/g, '');
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

function formatStatusLine(
  screen: TuiScreen,
  provider: string,
  strategy: string,
  model: string | undefined,
  scrollOffset: number,
  width: number,
): string {
  const sc = screenColor(screen);
  const modelName = model?.trim().length ? model : 'default';
  let status =
    `${sc}${BOLD}${screen.toUpperCase()}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}provider${RESET}=${FG_COPPER}${provider}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}strategy${RESET}=${FG_COPPER}${strategy}${RESET} ${FG_STEEL}\u2502${RESET} ` +
    `${FG_WARM}model${RESET}=${FG_COPPER}${modelName}${RESET}`;
  if (scrollOffset > 0) {
    status += ` ${FG_STEEL}\u2502${RESET} ${FG_COPPER}[Scroll: ${scrollOffset} up]${RESET}`;
  }
  return themeClip(status, width);
}

export class RootLayout implements Component {
  private _dirty = true;
  private _children: Component[] = [];

  constructor(
    private _screen: TuiScreen = 'dashboard',
    private _mode: 'normal' | 'palette' = 'normal',
    private _paletteInput: string = '',
    private _scrollOffset: number = 0,
  ) {}

  // ── Getters ────────────────────────────────────────────────────────────────

  get screen(): TuiScreen {
    return this._screen;
  }

  get mode(): 'normal' | 'palette' {
    return this._mode;
  }

  get paletteInput(): string {
    return this._paletteInput;
  }

  get scrollOffset(): number {
    return this._scrollOffset;
  }

  // ── Component interface ───────────────────────────────────────────────────

  render(_width: number): string[] {
    // This is a no-op; use renderWithContext() for actual rendering
    return [];
  }

  /**
   * Full render with application state passed in.
   * This replaces the old buildScreenLines function.
   */
  renderWithContext(
    options: LayoutRenderOptions,
    dashboardData?: { stats: unknown; activities: unknown; insights: unknown },
  ): string[] {
    const lines: string[] = [];
    const push = (s: string) => lines.push(s);

    const { history, obs, leftWidth, liveLine, scrollOffset, availableBodyRows, provider, strategy, model } = options;
    const termWidth = Math.max(80, output.columns || 80);
    const rightWidth = termWidth - leftWidth - 3;

    // ── Tab bar ─────────────────────────────────────────────────────────────
    push(`${FG_STEEL}${renderTabBar(this._screen)}${RESET}`);

    // ── Header ──────────────────────────────────────────────────────────────
    const sc = screenColor(this._screen);
    const headerLeft = `${MEMPHIS_LOGO_COMPACT} ${FG_STEEL}${BOX_BOLD.v}${RESET} ${sc}${BOLD}${this._screen.toUpperCase()}${RESET}`;
    const spark = obs.recentTimingsMs.length > 0
      ? `${FG_STEEL}⏱ ${obs.recentTimingsMs.at(-1) ?? 0}ms${RESET}`
      : '';
    const headerRight = spark;
    const headerGap = Math.max(1, termWidth - visualLength(headerLeft) - visualLength(headerRight) - 1);
    push(`${headerLeft}${' '.repeat(headerGap)}${headerRight}`);

    // ── Status line ─────────────────────────────────────────────────────────
    push(formatStatusLine(this._screen, provider, strategy, model, scrollOffset, termWidth));

    // ── Top border ──────────────────────────────────────────────────────────
    const borderH = BOX_BOLD.h;
    const leftBorder = borderH.repeat(leftWidth);
    const rightBorder = borderH.repeat(rightWidth);
    push(`${FG_COPPER}${BOX_BOLD.tl}${leftBorder}${BOX_BOLD.tee_down}${rightBorder}${BOX_BOLD.tr}${RESET}`);

    // ── Body ─────────────────────────────────────────────────────────────────
    if (this._mode === 'palette') {
      const commands = [
        '/backup list', '/backup create',
        '/screen dashboard', '/screen chat', '/screen health', '/screen embed', '/screen vault',
        '/provider auto', '/provider ollama',
        '/embed reset', '/embed store', '/embed search',
        '/health', '/obs', '/obs export', '/obs reset',
        '/guide', '/help', '/exit',
      ];
      const filtered = this._paletteInput
        ? commands.filter((c) => c.toLowerCase().includes(this._paletteInput.toLowerCase()))
        : commands;

      for (let row = 0; row < availableBodyRows; row += 1) {
        const cmd = filtered[row] ?? '';
        const left = themePadEnd(themeClip(cmd, leftWidth - 1), leftWidth - 1);
        const right = themePadEnd('', rightWidth - 1);
        push(
          `${FG_COPPER}${BOX_BOLD.v}${RESET}${left} ${FG_STEEL}${BOX_BOLD.v}${RESET}${right}${FG_STEEL}${BOX_BOLD.v}${RESET}`,
        );
      }
    } else {
      // Normal mode — dashboard or history
      const dashboardLines =
        this._screen === 'dashboard' && dashboardData
          ? renderDashboardScreen(
              dashboardData as Parameters<typeof renderDashboardScreen>[0],
              leftWidth,
            )
          : null;

      const historyLines = dashboardLines
        ? dashboardLines
        : wrapLines(liveLine ? [...history, liveLine] : history, leftWidth);

      const visibleHistory = historyLines.slice(
        Math.max(0, historyLines.length - availableBodyRows - scrollOffset),
        historyLines.length - scrollOffset,
      );

      for (let row = 0; row < availableBodyRows; row += 1) {
        const leftContent = visibleHistory[row] ?? '';
        const rightContent = '';
        const left = themePadEnd(themeClip(leftContent, leftWidth - 1), leftWidth - 1);
        const right = themePadEnd(themeClip(rightContent, rightWidth - 1), rightWidth - 1);
        push(
          `${sc}${BOX_BOLD.v}${RESET}${left} ${FG_STEEL}${BOX_BOLD.v}${RESET}${right}${FG_STEEL}${BOX_BOLD.v}${RESET}`,
        );
      }
    }

    // ── Bottom border ──────────────────────────────────────────────────────
    push(`${FG_COPPER}${BOX_BOLD.bl}${leftBorder}${BOX_BOLD.tee_up}${rightBorder}${BOX_BOLD.br}${RESET}`);

    return lines;
  }

  handleInput(_key: MemphisKey): void {
    // Navigation keys are handled by runTuiApp directly
    // This is here for interface compliance
  }

  invalidate(): void {
    this._dirty = true;
  }

  isDirty(): boolean {
    return this._dirty;
  }

  markClean(): void {
    this._dirty = false;
  }

  // ── State mutations ───────────────────────────────────────────────────────

  setScreen(screen: TuiScreen): void {
    this._screen = screen;
    this._scrollOffset = 0;
    this._dirty = true;
  }

  togglePalette(): void {
    this._mode = this._mode === 'palette' ? 'normal' : 'palette';
    this._paletteInput = '';
    this._dirty = true;
  }

  appendPaletteInput(char: string): void {
    this._paletteInput += char;
    this._dirty = true;
  }

  backspacePaletteInput(): void {
    this._paletteInput = this._paletteInput.slice(0, -1);
    this._dirty = true;
  }

  closePalette(): void {
    this._mode = 'normal';
    this._paletteInput = '';
    this._dirty = true;
  }

  scrollDown(lines = 10): void {
    this._scrollOffset += lines;
    this._dirty = true;
  }

  scrollUp(lines = 10): void {
    this._scrollOffset = Math.max(0, this._scrollOffset - lines);
    this._dirty = true;
  }

  scrollToTop(): void {
    this._scrollOffset = 0;
    this._dirty = true;
  }

  nextScreen(): void {
    const idx = SCREENS.indexOf(this._screen);
    this._screen = SCREENS[(idx + 1) % SCREENS.length];
    this._scrollOffset = 0;
    this._dirty = true;
  }
}
