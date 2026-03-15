import { describe, expect, it } from 'vitest';

import { enforceSafeModeNoEgress } from '../../src/infra/runtime/safe-mode.js';

describe('safe mode network enforcement', () => {
  it('does nothing when safe mode is disabled', () => {
    const out = enforceSafeModeNoEgress({ MEMPHIS_SAFE_MODE: 'false' } as NodeJS.ProcessEnv);
    expect(out.attempted).toBe(false);
    expect(out.enforced).toBe(false);
  });

  it('returns degraded result when iptables is unavailable', () => {
    const out = enforceSafeModeNoEgress({
      MEMPHIS_SAFE_MODE: 'true',
      PATH: '/definitely-missing-path',
    } as NodeJS.ProcessEnv);
    expect(out.attempted).toBe(true);
    expect(out.enforced).toBe(false);
  });
});
