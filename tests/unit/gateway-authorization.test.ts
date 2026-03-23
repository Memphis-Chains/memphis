import { describe, expect, it, vi } from 'vitest';

import { resolveToolPolicy } from '../../src/gateway/authorization.js';

vi.mock('../../src/gateway/tool-registry.js', () => ({
  getToolMeta: vi.fn((name: string) => {
    const tools: Record<string, { tier: number; description: string }> = {
      memphis_journal: { tier: 0, description: 'journal write' },
      memphis_exec: { tier: 2, description: 'shell execution' },
      memphis_vault_get: { tier: 1, description: 'vault read' },
    };
    return tools[name] ?? null;
  }),
}));

describe('gateway authorization — resolveToolPolicy', () => {
  it('denies unknown tools', () => {
    const result = resolveToolPolicy({
      toolName: 'nonexistent_tool',
      manifest: { mode: 'balanced', trustRules: [] } as never,
    });
    expect(result.policy).toBe('deny');
    expect(result.source).toBe('unknown-tool');
  });

  it('allows tier-0 tools in balanced mode', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: { mode: 'balanced', trustRules: [] } as never,
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('mode-default');
  });

  it('requires approval for tier-2 tools in balanced mode', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: { mode: 'balanced', trustRules: [] } as never,
    });
    expect(result.policy).toBe('require-approval');
  });

  it('allows tier-0 and tier-1 in quiet mode', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_vault_get',
      manifest: { mode: 'quiet', trustRules: [] } as never,
    });
    expect(result.policy).toBe('allow');
  });

  it('requires approval for all tiers in paranoid mode', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: { mode: 'paranoid', trustRules: [] } as never,
    });
    expect(result.policy).toBe('require-approval');
  });

  it('applies trust rule override', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: {
        mode: 'balanced',
        trustRules: [{ tool: 'memphis_exec', autoApprove: true }],
      } as never,
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('trust-rule');
  });

  it('applies wildcard trust rule', () => {
    const result = resolveToolPolicy({
      toolName: 'memphis_exec',
      manifest: {
        mode: 'paranoid',
        trustRules: [{ tool: '*', autoApprove: true }],
      } as never,
    });
    expect(result.policy).toBe('allow');
    expect(result.source).toBe('trust-rule');
  });

  it('explicit SQLite policy takes highest priority', () => {
    const permissionRepo = {
      get: vi.fn(() => ({ policy: 'deny' })),
    };
    const result = resolveToolPolicy({
      toolName: 'memphis_journal',
      permissionRepo: permissionRepo as never,
      manifest: { mode: 'quiet', trustRules: [] } as never,
    });
    expect(result.policy).toBe('deny');
    expect(result.source).toBe('explicit-policy');
  });
});
