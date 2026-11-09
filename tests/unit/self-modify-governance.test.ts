import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';

const { governance } = vi.hoisted(() => ({ governance: vi.fn() }));
vi.mock('../../src/mcp/tools/self-governance-status.js', () => ({ runMemphisSelfGovernanceStatus: governance }));
vi.mock('../../src/modules/self-coding/plan-store.js', () => ({ getPlan: vi.fn(), advanceStep: vi.fn() }));

describe('self-modification governance admission', () => {
  const input = { intent: 'fixture', files: ['a.ts'], changes: { 'a.ts': 'fixture' }, plan_id: 'p', step_idx: 0 };
  const env = { MEMPHIS_DATA_DIR: '/synthetic' };
  const deps = { sessionRepo: { create: vi.fn() }, rollback: { createSnapshot: vi.fn() },
    caseAdapter: {}, rawEnv: env } as unknown as Parameters<typeof runMemphisSelfModify>[1];
  beforeEach(() => vi.resetAllMocks());

  it('rejects an unavailable SLO before modifying the plan or creating a session', async () => {
    governance.mockResolvedValue({ canSelfModify: false, blockingReasons: ['SLO unavailable (24h): p99_turn_latency_ms'] });
    const result = await runMemphisSelfModify(input, deps);
    const { advanceStep, getPlan } = await import('../../src/modules/self-coding/plan-store.js');
    expect(result.success).toBe(false);
    expect(result.rollbackReason).toContain('SLO unavailable (24h): p99_turn_latency_ms');
    expect(governance).toHaveBeenCalledWith(env);
    expect(getPlan).not.toHaveBeenCalled();
    expect(advanceStep).not.toHaveBeenCalled();
    expect(deps.sessionRepo.create).not.toHaveBeenCalled();
    expect(deps.rollback.createSnapshot).not.toHaveBeenCalled();
  });

  it('fails closed if the governance check throws', async () => {
    governance.mockRejectedValue(new Error('fixture'));
    const result = await runMemphisSelfModify(input, deps);
    expect(result.rollbackReason).toBe('Self-modification blocked: governance status unavailable');
    expect(deps.sessionRepo.create).not.toHaveBeenCalled();
  });
});
