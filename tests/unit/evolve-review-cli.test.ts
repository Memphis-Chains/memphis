import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';

const mocks = vi.hoisted(() => ({ prompt: vi.fn(), operator: vi.fn(), governance: vi.fn(),
  inspect: vi.fn(), merge: vi.fn(), reconcile: vi.fn() }));
vi.mock('../../src/infra/cli/handlers/recovery.handler.js', () => ({ promptOperatorPassphrase: mocks.prompt }));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ requireOperatorAuth: vi.fn(), validateOperatorPassphrase: mocks.operator }));
vi.mock('../../src/infra/runtime/install-root.js', () => ({ resolveInstallRoot: () => '/tmp' }));
vi.mock('../../src/infra/runtime/evolve-review.js', () => ({ inspectEvolveReview: mocks.inspect, mergeEvolveReview: mocks.merge, reconcileEvolveReview: mocks.reconcile }));
vi.mock('../../src/mcp/tools/self-governance-status.js', () => ({ runMemphisSelfGovernanceStatus: mocks.governance }));
vi.mock('../../src/soul/manifest.js', () => ({ loadSoulManifest: () => ({ evolution: {
  passphraseHash: createHash('sha256').update('synthetic-tier2').digest('hex') } }) }));

describe('evolution operator review CLI', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const commit = 'b'.repeat(40);
  const review = { sessionId: id, root: '/tmp', target: 'main', base: 'a'.repeat(40), commit,
    branch: 'evolve/test', worktree: '/tmp/w', testSummary: '[]', status: 'prepared' };
  const store = { get: vi.fn(() => review), transition: vi.fn() };
  const context = { args: { command: 'evolve', subcommand: 'approve', target: id }, argv: [],
    getContainer: () => ({ evolveSessionRepository: { reviewStore: () => store, getById: () => ({ intent: 'fixture' }) } }) } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.inspect.mockResolvedValue('synthetic diff'); mocks.merge.mockResolvedValue(undefined);
    mocks.operator.mockReturnValue(true); mocks.governance.mockResolvedValue({ canSelfModify: true, blockingReasons: [] });
  });
  afterEach(() => vi.restoreAllMocks());
  it('merges only after exact commit confirmation and both local passwords', async () => {
    mocks.prompt.mockResolvedValueOnce(commit).mockResolvedValueOnce('synthetic-operator').mockResolvedValueOnce('synthetic-tier2');
    await evolveCommandHandler.handle(context);
    expect(mocks.merge).toHaveBeenCalledWith(store, id, '/tmp', commit);
    expect(mocks.governance).toHaveBeenCalledOnce();
  });
  it('refuses a wrong commit or Tier 2 password', async () => {
    mocks.prompt.mockResolvedValueOnce('wrong');
    await expect(evolveCommandHandler.handle(context)).rejects.toThrow('commit confirmation');
    expect(mocks.merge).not.toHaveBeenCalled();
    mocks.prompt.mockReset().mockResolvedValueOnce(commit).mockResolvedValueOnce('synthetic-operator').mockResolvedValueOnce('wrong');
    await expect(evolveCommandHandler.handle(context)).rejects.toThrow('Tier 2 authentication failed');
    expect(mocks.merge).not.toHaveBeenCalled();
  });
  it('refuses when governance changes during review', async () => {
    mocks.prompt.mockResolvedValueOnce(commit).mockResolvedValueOnce('synthetic-operator').mockResolvedValueOnce('synthetic-tier2');
    mocks.governance.mockResolvedValue({ canSelfModify: false, blockingReasons: ['SLO unavailable'] });
    await expect(evolveCommandHandler.handle(context)).rejects.toThrow('SLO unavailable');
    expect(mocks.merge).not.toHaveBeenCalled();
  });
});
