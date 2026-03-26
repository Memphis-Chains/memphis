import { describe, expect, it } from 'vitest';

import {
  clampLeftWidth,
  clampScrollOffset,
  resolveSplitPanelLayout,
  sliceVisibleLines,
} from '../src/tui/layout-math.js';

describe('tui layout math', () => {
  it('clamps the left panel when the terminal shrinks', () => {
    const layout = resolveSplitPanelLayout(100, 32, 90);

    expect(layout.leftWidth).toBe(67);
    expect(layout.rightWidth).toBe(30);
    expect(layout.availableBodyRows).toBe(25);
  });

  it('keeps the left panel within sane minimum bounds', () => {
    expect(clampLeftWidth(80, 10)).toBe(30);
  });

  it('clamps overscroll to the oldest visible page instead of rendering empty content', () => {
    expect(clampScrollOffset(999, 5, 2)).toBe(3);
    expect(sliceVisibleLines(['1', '2', '3', '4', '5'], 2, 999)).toEqual(['1', '2']);
  });

  it('returns the latest page when scroll offset is zero', () => {
    expect(sliceVisibleLines(['1', '2', '3', '4', '5'], 2, 0)).toEqual(['4', '5']);
  });
});
