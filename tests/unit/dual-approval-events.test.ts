import { describe, expect, it, vi, beforeEach } from 'vitest';

import { writeDualApprovalChainEvent } from '../../src/infra/runtime/dual-approval-events.js';

vi.mock('../../src/infra/storage/chain-adapter.js', () => ({
  appendBlock: vi.fn(async () => ({ index: 1, hash: 'abc', chain: 'system' })),
}));

vi.mock('../../src/infra/logging/security-audit.js', () => ({
  writeSecurityAudit: vi.fn(),
}));

describe('dual-approval-events', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('writes chain event on approval transition', async () => {
    const { appendBlock } = await import('../../src/infra/storage/chain-adapter.js');
    vi.mocked(appendBlock).mockResolvedValue({ index: 1, hash: 'abc', chain: 'system' } as never);

    await writeDualApprovalChainEvent({
      requestId: 'req-1',
      correlationTaskId: 'task-1',
      action: 'approve',
      fromState: 'pending',
      toState: 'approved',
      actorId: 'admin-1',
      stateVersion: 2,
      signatureVerified: true,
    } as never);

    expect(appendBlock).toHaveBeenCalledWith(
      'system',
      expect.objectContaining({
        type: 'system_event',
        event: 'dual_approval.transition',
        schemaVersion: 1,
        payload: expect.objectContaining({
          action: 'approve',
          fromState: 'pending',
          toState: 'approved',
          actorId: 'admin-1',
          signatureVerified: true,
        }),
      }),
      expect.anything(),
    );
  });

  it('logs security audit on chain append failure', async () => {
    const { appendBlock } = await import('../../src/infra/storage/chain-adapter.js');
    const { writeSecurityAudit } = await import('../../src/infra/logging/security-audit.js');
    vi.mocked(appendBlock).mockRejectedValue(new Error('chain write failed'));

    await writeDualApprovalChainEvent({
      requestId: 'req-2',
      correlationTaskId: 'task-2',
      action: 'request',
      fromState: null,
      toState: 'pending',
      actorId: 'user-1',
      stateVersion: 1,
      signatureVerified: false,
    } as never);

    expect(writeSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'dual_approval.chain_event',
        status: 'error',
      }),
      expect.anything(),
    );
  });

  it('event block includes UUID eventId and ISO timestamp', async () => {
    const { appendBlock } = await import('../../src/infra/storage/chain-adapter.js');
    vi.mocked(appendBlock).mockResolvedValue({ index: 1, hash: 'abc', chain: 'system' } as never);

    await writeDualApprovalChainEvent({
      requestId: 'req-3',
      correlationTaskId: 'task-3',
      action: 'cancel',
      fromState: 'pending',
      toState: 'canceled',
      actorId: 'admin-2',
      stateVersion: 3,
      signatureVerified: true,
    } as never);

    const callArg = vi.mocked(appendBlock).mock.calls[0]![1] as Record<string, unknown>;
    expect(callArg.eventId).toBeDefined();
    expect(typeof callArg.eventId).toBe('string');
    expect(callArg.timestamp).toBeDefined();
    expect(new Date(callArg.timestamp as string).toISOString()).toBe(callArg.timestamp);
  });
});
