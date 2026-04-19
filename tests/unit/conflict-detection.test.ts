import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as auditModule from '../../src/infra/logging/security-audit.js';
import {
  detectProviderKeyConflicts,
  reportProviderKeyConflicts,
} from '../../src/providers/conflict-detection.js';
import * as providersIndex from '../../src/providers/index.js';

type Resolution = ReturnType<typeof providersIndex.resolveProviderKeyResult>;

function mockResolution(
  source: 'vault' | 'plaintext' | 'conflict' | 'none',
  extras: Partial<{ key: string; vaultError: string }> = {},
): Resolution {
  if (source === 'vault') return { source: 'vault', key: extras.key ?? 'vault-key' };
  if (source === 'plaintext') return { source: 'plaintext', key: extras.key ?? 'plaintext-key' };
  if (source === 'conflict') {
    return {
      source: 'conflict',
      vaultError: extras.vaultError ?? 'vault entry missing for minimax_api_key',
      plaintextKey: extras.key ?? 'plain',
    };
  }
  return { source: 'none', reason: 'vault_not_configured' };
}

let audit: Array<{ action: string; details: Record<string, unknown> }> = [];

beforeEach(() => {
  audit = [];
  vi.spyOn(auditModule, 'writeSecurityAudit').mockImplementation((event) => {
    audit.push({ action: event.action, details: event.details ?? {} });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectProviderKeyConflicts', () => {
  it('returns empty when only vault ref is set (no plaintext)', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(mockResolution('vault'));
    const conflicts = detectProviderKeyConflicts({
      MINIMAX_VAULT_KEY: 'minimax_api_key',
    } as NodeJS.ProcessEnv);
    expect(conflicts).toEqual([]);
  });

  it('returns empty when plaintext is a VAULT: reference (not an actual value)', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(mockResolution('vault'));
    const conflicts = detectProviderKeyConflicts({
      MINIMAX_VAULT_KEY: 'minimax_api_key',
      MINIMAX_API_KEY: 'VAULT:minimax_api_key',
    } as NodeJS.ProcessEnv);
    expect(conflicts).toEqual([]);
  });

  it('flags warn when both vault ref + plaintext are set and vault resolves cleanly', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(mockResolution('vault'));
    const conflicts = detectProviderKeyConflicts({
      MINIMAX_VAULT_KEY: 'minimax_api_key',
      MINIMAX_API_KEY: 'sk-plain-redundant',
    } as NodeJS.ProcessEnv);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      provider: 'minimax',
      severity: 'warn',
      reason: 'vault_ref_and_plaintext_both_set',
    });
  });

  it('flags error when vault ref is set but vault resolution produces a conflict', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(
      mockResolution('conflict', { vaultError: 'vault entry missing for minimax_api_key' }),
    );
    const conflicts = detectProviderKeyConflicts({
      MINIMAX_VAULT_KEY: 'minimax_api_key',
      MINIMAX_API_KEY: 'sk-plain',
    } as NodeJS.ProcessEnv);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].severity).toBe('error');
    expect(conflicts[0].reason).toBe('vault_ref_set_but_entry_missing_with_plaintext_fallback');
  });

  it('categorizes decryption errors separately from missing-entry errors', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(
      mockResolution('conflict', { vaultError: 'failed to decrypt entry: integrity check failed' }),
    );
    const conflicts = detectProviderKeyConflicts({
      ANTHROPIC_VAULT_KEY: 'anthropic_api_key',
      ANTHROPIC_API_KEY: 'sk-plain',
    } as NodeJS.ProcessEnv);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe('vault_decryption_error_with_plaintext_fallback');
  });

  it('scans every descriptor independently', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockImplementation((provider: string) => {
      if (provider === 'deepseek') return mockResolution('vault');
      if (provider === 'glm')
        return mockResolution('conflict', { vaultError: 'vault entry missing for glm_api_key' });
      return mockResolution('none');
    });

    const conflicts = detectProviderKeyConflicts({
      DEEPSEEK_VAULT_KEY: 'deepseek_api_key',
      DEEPSEEK_API_KEY: 'redundant',
      GLM_VAULT_KEY: 'glm_api_key',
      GLM_API_KEY: 'plain-fallback',
    } as NodeJS.ProcessEnv);

    expect(conflicts.map((c) => c.provider).sort()).toEqual(['deepseek', 'glm']);
  });
});

describe('reportProviderKeyConflicts', () => {
  it('writes one line per conflict to the writer and emits audit events', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(mockResolution('vault'));
    const writes: string[] = [];
    reportProviderKeyConflicts(
      {
        MINIMAX_VAULT_KEY: 'minimax_api_key',
        MINIMAX_API_KEY: 'sk-plain-redundant',
      } as NodeJS.ProcessEnv,
      (line) => writes.push(line),
    );
    expect(writes.some((l) => l.includes('minimax') && l.includes('WARN'))).toBe(true);
    expect(audit.some((a) => a.action === 'provider.key-conflict')).toBe(true);
  });

  it('shouldExit=true when strict mode on and any conflict is present', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(mockResolution('vault'));
    const outcome = reportProviderKeyConflicts(
      {
        MEMPHIS_STRICT_MODE: 'true',
        MINIMAX_VAULT_KEY: 'minimax_api_key',
        MINIMAX_API_KEY: 'sk-plain',
      } as NodeJS.ProcessEnv,
      () => {},
    );
    expect(outcome.shouldExit).toBe(true);
    expect(outcome.strictMode).toBe(true);
  });

  it('shouldExit=false when strict mode is off even with error-level conflicts', () => {
    vi.spyOn(providersIndex, 'resolveProviderKeyResult').mockReturnValue(
      mockResolution('conflict', { vaultError: 'vault entry missing for glm_api_key' }),
    );
    const outcome = reportProviderKeyConflicts(
      {
        GLM_VAULT_KEY: 'glm_api_key',
        GLM_API_KEY: 'plain',
      } as NodeJS.ProcessEnv,
      () => {},
    );
    expect(outcome.shouldExit).toBe(false);
    expect(outcome.conflicts.some((c) => c.severity === 'error')).toBe(true);
  });
});
