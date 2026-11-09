import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';

const mocks = vi.hoisted(() => ({ prompt: vi.fn(), operator: vi.fn(), governance: vi.fn(),
  inspect: vi.fn(), merge: vi.fn(), reconcile: vi.fn(), manifest: vi.fn() }));
vi.mock('../../src/infra/cli/handlers/recovery.handler.js', () => ({ promptOperatorPassphrase: mocks.prompt }));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ requireOperatorAuth: vi.fn(), validateOperatorPassphrase: mocks.operator }));
// `resolveInstallRoot` is mocked, but the handler still resolves the result
// through `realpathSync`. The fixture therefore hands the handler a path
// that is NOT canonical — a symlink to a real directory — so the resolved
// root differs from the returned root on every platform.
//
// Measured 2026-11-09: on macOS `/tmp` is a symlink to `/private/tmp`, so
// the handler compared `realpathSync('/tmp')` against the review's stored
// root and refused the review as belonging to another repository — on the
// macOS CI runner only, and for a reason the failure message did not name.
// A fixture that used the literal `/tmp` reproduced that only on macOS,
// so the same mistake stayed invisible on every other platform. The
// symlink makes the difference real everywhere.
const installRoot = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const base = mkdtempSync(join(tmpdir(), 'memphis-evolve-root-'));
  const real = join(base, 'real');
  mkdirSync(real);
  const linked = join(base, 'linked');
  symlinkSync(real, linked);
  return { returned: linked, resolved: realpathSync(linked) };
});
vi.mock('../../src/infra/runtime/install-root.js', () => ({
  resolveInstallRoot: () => installRoot.returned,
}));
vi.mock('../../src/config/paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/paths.js')>()),
  getDataDir: () => '/tmp',
}));
vi.mock('../../src/infra/runtime/evolve-review.js', () => ({ inspectEvolveReview: mocks.inspect, mergeEvolveReview: mocks.merge, reconcileEvolveReview: mocks.reconcile }));
vi.mock('../../src/mcp/tools/self-governance-status.js', () => ({ runMemphisSelfGovernanceStatus: mocks.governance }));
vi.mock('../../src/soul/manifest.js', () => ({ loadSoulManifest: mocks.manifest }));

describe('evolution operator review CLI', () => {
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const commit = 'b'.repeat(40);
  const review = { sessionId: id, root: installRoot.resolved, target: 'main', base: 'a'.repeat(40), commit,
    branch: 'evolve/test', worktree: '/tmp/w', testSummary: '[]', status: 'prepared' };
  const store = { get: vi.fn(() => review), transition: vi.fn() };
  const context = { args: { command: 'evolve', subcommand: 'approve', target: id }, argv: [],
    getContainer: () => ({ evolveSessionRepository: { reviewStore: () => store, getById: () => ({ intent: 'fixture' }) } }) } as never;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.inspect.mockResolvedValue('synthetic diff'); mocks.merge.mockResolvedValue(undefined);
    mocks.manifest.mockReturnValue({ evolution: { passphraseHash: createHash('sha256').update('synthetic-tier2').digest('hex') } });
    mocks.operator.mockReturnValue(true); mocks.governance.mockResolvedValue({ canSelfModify: true, blockingReasons: [] });
  });
  afterEach(() => vi.restoreAllMocks());
  it('merges only after exact commit confirmation and both local passwords', async () => {
    mocks.prompt.mockResolvedValueOnce(commit).mockResolvedValueOnce('synthetic-operator').mockResolvedValueOnce('synthetic-tier2');
    await evolveCommandHandler.handle(context);
    expect(mocks.merge).toHaveBeenCalledWith(store, id, installRoot.resolved, commit);
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
  it('uses one fresh operator prompt in explicit operator mode', async () => {
    mocks.manifest.mockReturnValue({ evolution: { tier2AuthMode: 'operator' } });
    mocks.operator.mockImplementation((value: string) => value === 'synthetic-operator');
    mocks.prompt.mockResolvedValueOnce(commit).mockResolvedValueOnce('synthetic-operator');
    await evolveCommandHandler.handle(context);
    expect(mocks.prompt).toHaveBeenCalledTimes(2);
    expect(mocks.merge).toHaveBeenCalledWith(store, id, installRoot.resolved, commit);
  });
});
