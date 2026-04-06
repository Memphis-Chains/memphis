/**
 * Unit tests for the authorization module.
 */
import { describe, expect, it } from 'vitest';

import { resolveToolPolicy } from '../../src/gateway/authorization.js';
import type { SoulManifest } from '../../src/soul/types.js';

function makeManifest(
  overrides: Partial<Pick<SoulManifest, 'mode' | 'trustRules'>> = {},
): SoulManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      agentName: 'test-agent',
      ownerName: 'test-owner',
      runtimeMode: 'test',
      createdAt: new Date().toISOString(),
    },
    capabilities: {
      tools: [],
      chains: [],
      channels: [],
      providers: [],
      rustBridge: false,
    },
    boundaries: {
      tier0: { auth: 'none', scope: 'test' },
      tier1: { auth: 'api_token', scope: 'test' },
      tier2: { auth: 'vault_passphrase', scope: 'test' },
    },
    evolution: {
      autoApproveReflections: true,
      requirePassphraseForTier2: true,
      snapshotBeforeEvolution: true,
    },
    mode: overrides.mode ?? 'balanced',
    trustRules: overrides.trustRules ?? [],
  };
}

describe('resolveToolPolicy', () => {
  // Unknown tool
  it('denies unknown tools', () => {
    const result = resolveToolPolicy({
      toolName: 'nonexistent_tool',
      manifest: makeManifest(),
    });
    expect(result.policy).toBe('deny');
    expect(result.source).toBe('unknown-tool');
  });

  // Mode defaults — quiet
  it('quiet mode: tier0 → allow', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: makeManifest({ mode: 'quiet' }),
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('mode-default');
  });

  it('quiet mode: tier2 → require-approval (web_fetch)', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_web_fetch',
      manifest: makeManifest({ mode: 'quiet' }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('mode-default');
  });

  it('quiet mode: tier2 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: makeManifest({ mode: 'quiet' }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('mode-default');
  });

  // Mode defaults — balanced
  it('balanced mode: tier0 → allow', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: makeManifest({ mode: 'balanced' }),
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('mode-default');
  });

  it('balanced mode: tier1 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_web_fetch',
      manifest: makeManifest({ mode: 'balanced' }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('mode-default');
  });

  it('balanced mode: tier2 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: makeManifest({ mode: 'balanced' }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('mode-default');
  });

  // Mode defaults — paranoid
  it('paranoid mode: tier0 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: makeManifest({ mode: 'paranoid' }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('mode-default');
  });

  it('paranoid mode: tier1 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_web_fetch',
      manifest: makeManifest({ mode: 'paranoid' }),
    });
    expect(result.policy).toBe('require-approval');
  });

  it('paranoid mode: tier2 → require-approval', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: makeManifest({ mode: 'paranoid' }),
    });
    expect(result.policy).toBe('require-approval');
  });

  // Trust rules
  it('trust rule auto-approve overrides mode default', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_web_fetch',
      manifest: makeManifest({
        mode: 'balanced',
        trustRules: [
          { tool: 'memphis_web_fetch', autoApprove: true, addedAt: new Date().toISOString() },
        ],
      }),
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('trust-rule');
  });

  it('trust rule require-approval overrides quiet mode', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: makeManifest({
        mode: 'quiet',
        trustRules: [
          { tool: 'memphis_journal', autoApprove: false, addedAt: new Date().toISOString() },
        ],
      }),
    });
    expect(result.policy).toBe('require-approval');
    expect(result.source).toBe('trust-rule');
  });

  it('wildcard trust rule matches any tool', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: makeManifest({
        mode: 'paranoid',
        trustRules: [{ tool: '*', autoApprove: true, addedAt: new Date().toISOString() }],
      }),
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('trust-rule');
  });

  // Tier is always returned correctly
  it('returns correct tier for each tool', () => {
    const manifest = makeManifest();
    expect(resolveToolPolicy({ toolName: 'memphis_journal', manifest }).tier).toBe(0);
    expect(resolveToolPolicy({ toolName: 'memphis_web_fetch', manifest }).tier).toBe(2);
    expect(resolveToolPolicy({ toolName: 'memphis_exec', manifest }).tier).toBe(2);
  });

  // Reason string is populated
  it('provides a reason string', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: makeManifest(),
    });
    expect(result.reason.length).toBeGreaterThan(0);
  });
});
