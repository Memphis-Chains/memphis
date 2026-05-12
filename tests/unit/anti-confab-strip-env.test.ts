/**
 * S1 operator decision 2026-05-12: phase 3 (strip-sentence) opt-in
 * via the cleaner `MEMPHIS_ANTICONFAB_STRIP=1` env alias.
 * `MEMPHIS_ANTICONFAB_PHASE` still works for back-compat + A/B.
 */
import { describe, expect, it } from 'vitest';

import { resolveConfabPhase } from '../../src/gateway/turn-runtime.js';

describe('resolveConfabPhase — MEMPHIS_ANTICONFAB_STRIP alias', () => {
  it('default (no envs set) is phase 2 (warn-append)', () => {
    expect(resolveConfabPhase({})).toBe(2);
  });

  it.each(['1', 'true', 'on', 'TRUE', 'On'])(
    'MEMPHIS_ANTICONFAB_STRIP=%s flips to phase 3',
    (value) => {
      expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_STRIP: value })).toBe(3);
    },
  );

  it.each(['0', 'false', 'off', ''])(
    'MEMPHIS_ANTICONFAB_STRIP=%s does NOT flip — falls back to phase env or default',
    (value) => {
      expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_STRIP: value })).toBe(2);
    },
  );

  it('MEMPHIS_ANTICONFAB_PHASE=3 still works (back-compat)', () => {
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '3' })).toBe(3);
  });

  it('STRIP=1 takes precedence over PHASE=0 (operator forced strip beats explicit off)', () => {
    expect(
      resolveConfabPhase({
        MEMPHIS_ANTICONFAB_STRIP: '1',
        MEMPHIS_ANTICONFAB_PHASE: '0',
      }),
    ).toBe(3);
  });

  it('PHASE=1 still selectable when STRIP is unset', () => {
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '1' })).toBe(1);
  });
});
