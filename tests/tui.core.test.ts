import { describe, expect, it } from 'vitest';
import { keybindToScreen, normalizeScreen } from '../src/tui/core.js';

describe('tui core helpers', () => {
  it('normalizes valid screens', () => {
    expect(normalizeScreen('chat')).toBe('chat');
    expect(normalizeScreen('health')).toBe('health');
    expect(normalizeScreen('embed')).toBe('embed');
    expect(normalizeScreen('vault')).toBe('vault');
  });

  it('rejects unknown screen', () => {
    expect(normalizeScreen('x')).toBeNull();
  });

  it('maps ctrl+number keybind names to screens', () => {
    expect(keybindToScreen('1')).toBe('chat');
    expect(keybindToScreen('2')).toBe('health');
    expect(keybindToScreen('3')).toBe('embed');
    expect(keybindToScreen('4')).toBe('vault');
    expect(keybindToScreen('9')).toBeNull();
  });
});
