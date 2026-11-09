import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trustCommandHandler } from '../../src/infra/cli/handlers/trust.handler.js';

const mocks = vi.hoisted(() => ({ prompt: vi.fn(), operator: vi.fn(), load: vi.fn(), write: vi.fn() }));
vi.mock('../../src/infra/cli/handlers/recovery.handler.js', () => ({ promptOperatorPassphrase: mocks.prompt }));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ validateOperatorPassphrase: mocks.operator, requireOperatorAuth: vi.fn() }));
vi.mock('../../src/soul/manifest.js', () => ({ loadSoulManifest: mocks.load, writeSoulManifest: mocks.write, ensureSoulManifest: vi.fn() }));

function context(mode: string) {
  return { args: { command: 'trust', subcommand: 'tier2', target: mode }, argv: [] } as never;
}

describe('trust tier2 operator configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.operator.mockImplementation((value: string) => value === 'operator-secret');
  });
  afterEach(() => vi.restoreAllMocks());

  it('requires the operator credential and explicitly writes the selected mode', async () => {
    const original = { mode: 'balanced', evolution: { requirePassphraseForTier2: true } };
    mocks.load.mockImplementation(() => structuredClone(original));
    mocks.prompt.mockResolvedValueOnce('operator-secret');
    await trustCommandHandler.handle(context('operator'));
    expect(mocks.write).toHaveBeenCalledOnce();
    expect(mocks.write.mock.calls[0][0].evolution.tier2AuthMode).toBe('operator');
    expect(JSON.stringify(mocks.write.mock.calls[0][0])).not.toContain('operator-secret');
  });

  it('does not write when operator authentication fails', async () => {
    mocks.prompt.mockResolvedValueOnce('wrong');
    await expect(trustCommandHandler.handle(context('operator'))).rejects.toThrow('operator authentication failed');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('requires an existing separate credential before switching away from it', async () => {
    const original = { evolution: { passphraseHash: createHash('sha256').update('separate-secret').digest('hex') } };
    mocks.load.mockImplementation(() => structuredClone(original));
    mocks.prompt.mockResolvedValueOnce('operator-secret').mockResolvedValueOnce('wrong');
    await expect(trustCommandHandler.handle(context('operator'))).rejects.toThrow('Tier 2 authentication failed');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('preserves the separate verifier after both credentials succeed', async () => {
    const hash = createHash('sha256').update('separate-secret').digest('hex');
    mocks.load.mockImplementation(() => ({ evolution: { passphraseHash: hash } }));
    mocks.prompt.mockResolvedValueOnce('operator-secret').mockResolvedValueOnce('separate-secret');
    await trustCommandHandler.handle(context('operator'));
    expect(mocks.write.mock.calls[0][0].evolution).toEqual({ tier2AuthMode: 'operator', passphraseHash: hash });
  });

  it('refuses a concurrent change to the credential before writing', async () => {
    mocks.load.mockReturnValueOnce({ evolution: {} }).mockReturnValueOnce({ evolution: { passphraseHash: 'changed' } });
    mocks.prompt.mockResolvedValueOnce('operator-secret');
    await expect(trustCommandHandler.handle(context('operator'))).rejects.toThrow('changed during authentication');
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('refuses separate mode without a configured verifier', async () => {
    mocks.load.mockReturnValue({ evolution: { tier2AuthMode: 'operator' } });
    mocks.prompt.mockResolvedValueOnce('operator-secret');
    await expect(trustCommandHandler.handle(context('separate'))).rejects.toThrow('not configured');
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
