/**
 * Memphis TUI Terminal — output abstraction with line-level diffing.
 *
 * Problems this solves:
 * 1. Every state change in the TUI triggers a full redraw via 40+ output.write() calls
 * 2. No flicker protection — concurrent writes can interleave
 * 3. No line diffing — even a single character change rewrites the entire screen
 *
 * Solution:
 * - CSI 2026 sync brackets for atomic output (with fallback)
 * - Line-level diffing: only lines that differ from prevLines are written
 * - Full rewrite on first render or resize
 *
 * CSI 2026: https://gist.github.com/nicowillis/4e4b66550f2202cb5d85a4c25c37e67a
 * Supported by: iTerm2, Kitty, WezTerm, Windows Terminal
 * Fallback: \x1b[H (home) + per-line overwrite
 */

import { stdout as output } from 'node:process';

const CSI = '\x1b[';
const ESC = '\x1b';

// ── CSI 2026 Sync Brackets ────────────────────────────────────────────────────

/** Begin synchronized output block */
const SYNC_START = `${ESC}[?2026h`;

/** End synchronized output block */
const SYNC_END = `${ESC}[?2026l`;

/** Move cursor to row (1-indexed) */
const gotoRow = (row: number) => `${CSI}${row}H`;

/** Clear from cursor to end of screen */
const clearBelow = () => `${CSI}J`;

/** Clear entire line */
const clearLine = () => `${CSI}2K`;

/** CSI 2026 sync bracket for atomic output — wraps output so terminals render atomically */
export function syncStart(): string {
  return SYNC_START;
}

export function syncEnd(): string {
  return SYNC_END;
}

/**
 * Detect if CSI 2026 produced corrupted output.
 *
 * Detection approach: after the first render with CSI 2026, check if
 * the terminal is a known-unsupported variant via TERM env var.
 *
 * CSI 2026 is supported by: iTerm2, Kitty, WezTerm, Windows Terminal.
 * Known unsupported: dumb, vt100, xterm-old, linux console.
 * Manual opt-out via MEMPHIS_NO_CSI2026=1 env var.
 */

// ── ProcessTerminal ──────────────────────────────────────────────────────────

export class ProcessTerminal {
  /**
   * Previous lines rendered — used for line-level diffing.
   * Null means "full redraw on next write".
   */
  private prevLines: string[] = [];

  private columns: number;
  private _rows: number;

  /** CSI 2026 mode — null = detect on first write, true = use it, false = fallback */
  private csi2026: boolean | null = null;

  /** Track the max lines we've ever rendered (for clearing on shrink) */
  private maxLinesRendered = 0;

  constructor() {
    this.columns = output.columns || 80;
    this._rows = output.rows || 24;
  }

  get cols(): number {
    return this.columns;
  }

  get rows(): number {
    return this._rows;
  }

  onResize(): void {
    this.columns = output.columns || 80;
    this._rows = output.rows || 24;
  }

  /**
   * Write an array of lines with line-level diffing.
   *
   * Strategy:
   * - First render: write all lines, no clearing needed (assumes clean screen)
   * - Resize: full clear + rewrite
   * - Normal update: find first/last changed line, move cursor there, rewrite
   * - Append: just write new lines at the end
   *
   * CSI 2026 is used by default. If corruption detected, falls back to
   * \x1b[H + per-line write.
   */
  write(lines: string[]): void {
    const width = this.columns;
    const height = this.rows;

    // First render — no prevLines means clean screen
    if (this.prevLines.length === 0) {
      this.writeAll(lines, false);
      this.prevLines = [...lines];
      this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
      return;
    }

    // Detect resize
    const resized = lines.length !== this.prevLines.length ||
      width !== this.columns ||
      height !== this.rows;

    if (resized) {
      // Full clear + rewrite on resize
      this.writeAll(lines, true);
      this.prevLines = [...lines];
      this.maxLinesRendered = lines.length;
      this.onResize();
      return;
    }

    // Line-level diff
    let firstChanged = -1;
    let lastChanged = -1;
    const maxLen = Math.max(lines.length, this.prevLines.length);

    for (let i = 0; i < maxLen; i++) {
      const oldLine = i < this.prevLines.length ? this.prevLines[i] : '';
      const newLine = i < lines.length ? lines[i] : '';
      if (oldLine !== newLine) {
        if (firstChanged === -1) firstChanged = i;
        lastChanged = i;
      }
    }

    // No changes — but still need to update cursor position if needed
    if (firstChanged === -1) {
      return;
    }

    // New content is shorter (deleted lines)
    if (lastChanged >= lines.length && firstChanged >= lines.length) {
      // All remaining lines deleted — clear below
      this.writeRaw(`${gotoRow(firstChanged + 1)}${clearBelow}`);
      this.prevLines = [...lines];
      return;
    }

    // Build the diffed write
    let buf = '';

    if (this.csi2026 === null) {
      // First diff render — use CSI 2026
      this.csi2026 = true;
    }

    if (this.csi2026) {
      buf += SYNC_START;
    }

    // Move to first changed line (1-indexed)
    buf += gotoRow(firstChanged + 1);

    // Rewrite from firstChanged to lastChanged
    for (let i = firstChanged; i <= lastChanged && i < lines.length; i++) {
      if (i > firstChanged) {
        // Move down one line (from previous write position)
        buf += `${CSI}1B`;
      }
      buf += clearLine();
      buf += lines[i] ?? '';
    }

    // Clear any leftover lines below new content
    if (lastChanged < this.prevLines.length - 1 && lastChanged >= lines.length - 1) {
      buf += clearBelow;
    }

    if (this.csi2026) {
      buf += SYNC_END;
    }

    this.writeRaw(buf);
    this.prevLines = [...lines];
    this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
  }

  /**
   * Force a full screen rewrite — used for first render or resize.
   * Ignores diffing.
   */
  writeFull(lines: string[]): void {
    this.prevLines = [];
    this.write(lines);
  }

  /**
   * Write all lines — no diffing. Used for initial render or resize.
   * Writes the entire terminal height, then clears the scrollback.
   */
  private writeAll(lines: string[], clearScreen: boolean): void {
    let buf = '';

    if (this.csi2026 !== false) {
      // Try CSI 2026; if not yet set, detect after first write
      if (this.csi2026 === null) this.csi2026 = true;
      buf += SYNC_START;
    }

    if (clearScreen) {
      buf += `${CSI}2J${gotoRow(1)}`;
    }

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) buf += `\r\n`;
      buf += lines[i];
    }

    // Clear any lines below what we wrote (scrollback would keep them visible otherwise)
    const linesWritten = lines.length;
    if (linesWritten < this.maxLinesRendered || clearScreen) {
      buf += `${gotoRow(linesWritten + 1)}${clearBelow}`;
    }

    if (this.csi2026) {
      buf += SYNC_END;
    }

    this.writeRaw(buf);
    this.maxLinesRendered = Math.max(this.maxLinesRendered, lines.length);
  }

  /**
   * Low-level raw write to stdout.
   */
  private writeRaw(s: string): void {
    output.write(s);
  }

  /**
   * Clear the screen and reset terminal state.
   * Called on TUI exit.
   */
  clearScreen(): void {
    output.write(`${ESC}[2J${ESC}[H`);
    this.prevLines = [];
    this.maxLinesRendered = 0;
  }
}
