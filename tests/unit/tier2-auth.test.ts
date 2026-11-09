import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { usesOperatorForTier2, validateTier2Passphrase } from '../../src/infra/auth/tier2-auth.js';
import type { SoulManifest } from '../../src/soul/types.js';

const operator = vi.hoisted(() => vi.fn((value: string) => value === 'operator-secret'));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ validateOperatorPassphrase: operator }));
vi.mock('../../src/config/paths.js', () => ({
  getDataDir: (env?: NodeJS.ProcessEnv) => env === undefined || env === process.env ? '/runtime' : env.MEMPHIS_DATA_DIR ?? '/runtime',
}));

const manifest = (evolution: Record<string, unknown>) => ({ evolution }) as unknown as SoulManifest;

describe('explicit operator Tier 2 mode', () => {
  it('preserves the separate verifier when no mode is configured', () => {
    const legacy = manifest({ passphraseHash: createHash('sha256').update('separate-secret').digest('hex') });
    expect(usesOperatorForTier2(legacy)).toBe(false);
    expect(validateTier2Passphrase('separate-secret', legacy)).toBe('ok');
    expect(validateTier2Passphrase('operator-secret', legacy)).toBe('invalid');
    expect(validateTier2Passphrase('operator-secret', manifest({}))).toBe('missing');
    expect(validateTier2Passphrase('operator-secret', null)).toBe('missing');
  });

  it('validates the operator credential only when mode is explicitly selected', () => {
    const selected = manifest({ tier2AuthMode: 'operator' });
    expect(validateTier2Passphrase('operator-secret', selected)).toBe('ok');
    expect(validateTier2Passphrase('wrong', selected)).toBe('invalid');
    expect(validateTier2Passphrase(undefined, selected)).toBe('invalid');
  });

  it('rejects credentials from a different runtime data directory', () => {
    operator.mockClear();
    const selected = manifest({ tier2AuthMode: 'operator' });
    expect(validateTier2Passphrase('operator-secret', selected, { MEMPHIS_DATA_DIR: '/other' })).toBe('invalid');
    expect(operator).not.toHaveBeenCalled();
    expect(validateTier2Passphrase('operator-secret', selected, { MEMPHIS_DATA_DIR: '/runtime' })).toBe('ok');
  });
});
