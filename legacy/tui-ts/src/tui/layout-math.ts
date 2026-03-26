const MIN_TERMINAL_WIDTH = 80;
const MIN_TERMINAL_HEIGHT = 24;
const MIN_LEFT_PANEL_WIDTH = 30;
const MIN_RIGHT_PANEL_WIDTH = 30;
const SPLIT_PANEL_GUTTER = 3;
const RESERVED_CHROME_ROWS = 7;

export type SplitPanelLayout = {
  termWidth: number;
  termHeight: number;
  leftWidth: number;
  rightWidth: number;
  availableBodyRows: number;
};

export function clampLeftWidth(termWidth: number, requestedLeftWidth: number): number {
  const effectiveWidth = Math.max(MIN_TERMINAL_WIDTH, termWidth);
  const maxLeftWidth = Math.max(
    MIN_LEFT_PANEL_WIDTH,
    effectiveWidth - SPLIT_PANEL_GUTTER - MIN_RIGHT_PANEL_WIDTH,
  );
  return Math.max(MIN_LEFT_PANEL_WIDTH, Math.min(maxLeftWidth, requestedLeftWidth));
}

export function resolveSplitPanelLayout(
  columns: number | undefined,
  rows: number | undefined,
  requestedLeftWidth: number,
): SplitPanelLayout {
  const termWidth = Math.max(MIN_TERMINAL_WIDTH, columns ?? MIN_TERMINAL_WIDTH);
  const termHeight = Math.max(MIN_TERMINAL_HEIGHT, rows ?? MIN_TERMINAL_HEIGHT);
  const leftWidth = clampLeftWidth(termWidth, requestedLeftWidth);
  const rightWidth = termWidth - leftWidth - SPLIT_PANEL_GUTTER;
  const availableBodyRows = Math.max(1, termHeight - RESERVED_CHROME_ROWS);

  return {
    termWidth,
    termHeight,
    leftWidth,
    rightWidth,
    availableBodyRows,
  };
}

export function maxScrollOffset(totalLines: number, visibleRows: number): number {
  return Math.max(0, totalLines - visibleRows);
}

export function clampScrollOffset(
  scrollOffset: number,
  totalLines: number,
  visibleRows: number,
): number {
  return Math.max(0, Math.min(maxScrollOffset(totalLines, visibleRows), scrollOffset));
}

export function sliceVisibleLines(
  lines: readonly string[],
  visibleRows: number,
  scrollOffset: number,
): string[] {
  const clampedOffset = clampScrollOffset(scrollOffset, lines.length, visibleRows);
  const start = Math.max(0, lines.length - visibleRows - clampedOffset);
  const end = lines.length - clampedOffset;
  return lines.slice(start, end);
}
