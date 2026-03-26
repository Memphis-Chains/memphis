// ── Memphis TUI Theme ────────────────────────────────────────────────────────
// Rust-inspired palette: copper, warm gray, charcoal, oxidized accents.
// All colors use truecolor (24-bit) with graceful fallback to 256-color.

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDERLINE = '\x1b[4m';

// ── Foreground colors ────────────────────────────────────────────────────────

/** Rust copper — primary accent, headers, active borders */
export const FG_COPPER = '\x1b[38;2;205;133;63m';

/** Bright copper — highlighted elements, focus state */
export const FG_COPPER_BRIGHT = '\x1b[38;2;222;165;75m';

/** Oxidized red — errors, warnings, critical states */
export const FG_OXIDE = '\x1b[38;2;183;65;14m';

/** Warm gray — body text, secondary content */
export const FG_WARM = '\x1b[38;2;180;170;160m';

/** Cool gray — dimmed text, borders, separators */
export const FG_STEEL = '\x1b[38;2;120;115;110m';

/** Ferris teal — success states, positive indicators */
export const FG_TEAL = '\x1b[38;2;0;180;170m';

/** Chain blue — chain/block references, links */
export const FG_CHAIN = '\x1b[38;2;100;160;220m';

/** Vault purple — vault/security elements */
export const FG_VAULT = '\x1b[38;2;160;120;200m';

/** Embed gold — embedding/memory operations */
export const FG_EMBED = '\x1b[38;2;210;180;60m';

/** White — high-emphasis text */
export const FG_WHITE = '\x1b[38;2;235;230;225m';

// ── Background colors ────────────────────────────────────────────────────────

/** Dark charcoal — panel backgrounds */
export const BG_DARK = '\x1b[48;2;28;26;24m';

/** Slightly lighter — active panel */
export const BG_PANEL = '\x1b[48;2;38;35;32m';

/** Status bar background */
export const BG_STATUS = '\x1b[48;2;50;45;40m';

// ── Box-drawing ──────────────────────────────────────────────────────────────

export const BOX = {
  tl: '\u250c', // ┌
  tr: '\u2510', // ┐
  bl: '\u2514', // └
  br: '\u2518', // ┘
  h: '\u2500', // ─
  v: '\u2502', // │
  cross: '\u253c', // ┼
  tee_right: '\u251c', // ├
  tee_left: '\u2524', // ┤
  tee_down: '\u252c', // ┬
  tee_up: '\u2534', // ┴
} as const;

export const BOX_BOLD = {
  tl: '\u250f', // ┏
  tr: '\u2513', // ┓
  bl: '\u2517', // ┗
  br: '\u251b', // ┛
  h: '\u2501', // ━
  v: '\u2503', // ┃
  tee_right: '\u2523', // ┣
  tee_left: '\u252b', // ┫
  tee_down: '\u2533', // ┳
  tee_up: '\u253b', // ┻
} as const;

export const BOX_ROUND = {
  tl: '\u256d', // ╭
  tr: '\u256e', // ╮
  bl: '\u2570', // ╰
  br: '\u256f', // ╯
  h: '\u2500', // ─
  v: '\u2502', // │
} as const;

// ── Sparkline ────────────────────────────────────────────────────────────────

const SPARK_CHARS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588'; // ▁▂▃▄▅▆▇█

export function sparkline(values: number[], width = 12): string {
  if (values.length === 0) return '';
  const samples = values.slice(-width);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  return samples
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[idx];
    })
    .join('');
}

// ── Layout helpers ───────────────────────────────────────────────────────────

export function clip(value: string, width: number): string {
  if (width <= 1) return '\u2026';
  // Strip ANSI for length check but preserve in output
  const stripped = stripAnsi(value);
  if (stripped.length <= width) return value;
  // Truncate on visual length
  let visual = 0;
  let i = 0;
  while (i < value.length && visual < width - 1) {
    if (value[i] === '\x1b') {
      const end = value.indexOf('m', i);
      if (end !== -1) {
        i = end + 1;
        continue;
      }
    }
    visual++;
    i++;
  }
  return value.slice(0, i) + '\u2026' + RESET;
}

export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function visualLength(str: string): number {
  return stripAnsi(str).length;
}

/** Smart truncation that breaks on word boundaries when possible. */
export function smartClip(text: string, width: number): string {
  const stripped = stripAnsi(text);
  if (stripped.length <= width) return text;
  const cutoff = stripped.lastIndexOf(' ', width - 2);
  const breakPoint = cutoff > width * 0.6 ? cutoff : width - 2;
  return text.slice(0, breakPoint) + '..';
}

export function padEnd(str: string, width: number, ch = ' '): string {
  const vlen = visualLength(str);
  if (vlen >= width) return str;
  return str + ch.repeat(width - vlen);
}

export function padStart(str: string, width: number, ch = ' '): string {
  const vlen = visualLength(str);
  if (vlen >= width) return str;
  return ch.repeat(width - vlen) + str;
}

export function center(str: string, width: number, ch = ' '): string {
  const vlen = visualLength(str);
  if (vlen >= width) return str;
  const left = Math.floor((width - vlen) / 2);
  const right = width - vlen - left;
  return ch.repeat(left) + str + ch.repeat(right);
}

// ── Themed box renderer ──────────────────────────────────────────────────────

export function themedBox(
  title: string,
  lines: string[],
  width: number,
  borderColor: string,
  maxLines = 6,
): string[] {
  const inner = Math.max(10, width - 2);
  const b = BOX_ROUND;
  const bc = borderColor;

  const titleStr = title ? ` ${title} ` : '';
  const titleLen = stripAnsi(titleStr).length;
  const remainH = Math.max(0, inner - titleLen);
  const top = `${bc}${b.tl}${b.h}${BOLD}${FG_COPPER_BRIGHT}${titleStr}${RESET}${bc}${b.h.repeat(remainH)}${b.tr}${RESET}`;

  const body = lines.slice(0, maxLines).map((line) => {
    const clipped = clip(line, inner - 2);
    return `${bc}${b.v}${RESET} ${padEnd(clipped, inner - 2)}${bc}${b.v}${RESET}`;
  });

  // Fill remaining lines if less than maxLines
  const remaining = maxLines - body.length;
  for (let i = 0; i < remaining; i++) {
    body.push(`${bc}${b.v}${RESET} ${' '.repeat(inner - 2)}${bc}${b.v}${RESET}`);
  }

  const bottom = `${bc}${b.bl}${b.h.repeat(inner)}${b.br}${RESET}`;

  return [top, ...body, bottom];
}

// ── Status indicators ────────────────────────────────────────────────────────

export function statusDot(ok: boolean): string {
  return ok ? `${FG_TEAL}\u25cf${RESET}` : `${FG_OXIDE}\u25cf${RESET}`;
}

export function progressBar(value: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * width);
  const empty = width - filled;
  return `${FG_COPPER}\u2588${RESET}`.repeat(filled) + `${FG_STEEL}\u2591${RESET}`.repeat(empty);
}

// ── ASCII art header ─────────────────────────────────────────────────────────

export const MEMPHIS_LOGO = [
  `${FG_COPPER}    __  ___                   __    _      ${RESET}`,
  `${FG_COPPER_BRIGHT}   /  |/  /__  ____ ___  ____/ /_  (_)____ ${RESET}`,
  `${FG_COPPER}  / /|_/ / _ \\/ __ \`__ \\/ __ / __ \\/ / ___/ ${RESET}`,
  `${FG_COPPER_BRIGHT} / /  / /  __/ / / / / / /_/ / / / / (__  )  ${RESET}`,
  `${FG_OXIDE}/_/  /_/\\___/_/ /_/ /_/ .___/_/ /_/_/____/  ${RESET}`,
  `${FG_STEEL}                    /_/  ${DIM}sovereign runtime${RESET}`,
];

export const MEMPHIS_LOGO_COMPACT = `${FG_COPPER}${BOLD}Memphis${RESET}`;
