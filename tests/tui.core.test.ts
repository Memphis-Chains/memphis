import { describe, expect, it } from 'vitest';

import { keybindToScreen, normalizeScreen } from '../src/tui/core.js';

describe('tui core helpers', () => {
  it('normalizes valid screens', () => {
    expect(normalizeScreen('chat')).toBe('chat');
    expect(normalizeScreen('health')).toBe('system');
    expect(normalizeScreen('embed')).toBe('memory');
    expect(normalizeScreen('vault')).toBe('vault');
    expect(normalizeScreen('dashboard')).toBe('overview');
    expect(normalizeScreen('decisions')).toBe('cases');
    expect(normalizeScreen('sessions')).toBe('sessions');
  });

  it('rejects unknown screen', () => {
    expect(normalizeScreen('x')).toBeNull();
  });

  it('maps ctrl+number keybind names to screens', () => {
    expect(keybindToScreen('1')).toBe('overview');
    expect(keybindToScreen('2')).toBe('chat');
    expect(keybindToScreen('3')).toBe('memory');
    expect(keybindToScreen('4')).toBe('sessions');
    expect(keybindToScreen('5')).toBe('vault');
    expect(keybindToScreen('6')).toBe('cases');
    expect(keybindToScreen('7')).toBe('system');
    expect(keybindToScreen('9')).toBeNull();
  });
});
