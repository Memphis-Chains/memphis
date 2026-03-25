/**
 * Simple ANSI Renderer — converts markdown-like text to ANSI escape sequences.
 *
 * Supported patterns:
 * - **bold** → \x1b[1m bold \x1b[0m
 * - `code` → FG_COPPER on dim background
 * - _italic_ → \x1b[3m italic \x1b[0m (if supported)
 * - Links are NOT rendered specially (stripped to URL in parens)
 *
 * No external dependencies — ~60 lines.
 * If chat messages don't need formatting, this can be skipped.
 */

import {
  BOLD,
  FG_CHAIN,
  FG_COPPER,
  FG_TEAL,
  RESET,
  UNDERLINE,
} from './theme.js';

/** Render markdown-like text to ANSI. Returns the same string if no patterns found. */
export function renderAnsi(text: string): string {
  // Escape RESET sequences to prevent nested reset issues
  let s = text;

  // Bold: **text** or __text__
  s = s.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`);
  s = s.replace(/__(.+?)__/g, `${BOLD}$1${RESET}`);

  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, `${FG_COPPER}$1${RESET}`);

  // Italic: *text* or _text_ (skip if already bold)
  s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, `${FG_TEAL}$1${RESET}`);
  s = s.replace(/(?<!_)_(?!_)(.+?)_(?!_)/g, `${FG_TEAL}$1${RESET}`);

  // Links: [text](url) → text (url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${FG_CHAIN}${UNDERLINE}$1${RESET} ($2)`);

  return s;
}

/** Strip all ANSI codes and markdown, returning plain text. */
export function stripAll(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '');
}
