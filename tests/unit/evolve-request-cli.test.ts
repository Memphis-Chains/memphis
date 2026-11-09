import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';
import { EvolveRequestStore } from '../../src/infra/runtime/evolve-request.js';

const mocks = vi.hoisted(() => ({ prompt: vi.fn(), operator: vi.fn(), prepare: vi.fn() }));
vi.mock('../../src/infra/cli/handlers/recovery.handler.js', () => ({ promptOperatorPassphrase: mocks.prompt }));
vi.mock('../../src/infra/auth/operator-gate.js', () => ({ requireOperatorAuth: vi.fn(), validateOperatorPassphrase: mocks.operator }));
vi.mock('../../src/infra/runtime/install-root.js', () => ({ resolveInstallRoot: () => '/tmp' }));
vi.mock('../../src/mcp/tools/self-modify.js', () => ({ runMemphisSelfModify: mocks.prepare }));
vi.mock('../../src/soul/manifest.js', () => ({ loadSoulManifest: () => ({ evolution: {
  passphraseHash: createHash('sha256').update('synthetic-tier2').digest('hex') } }) }));
vi.mock('../../src/backup/rollback.js', () => ({ RollbackManager: class {} }));
vi.mock('../../src/infra/storage/case-chain-adapter.js', () => ({ CaseChainAdapter: class {} }));
vi.mock('../../src/config/paths.js', () => ({ getDataDir: () => '/tmp' }));

describe('local approval of an evolution request', () => {
  let db: Database.Database; let store: EvolveRequestStore;
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'log').mockImplementation(() => {});
    db = new Database(':memory:'); store = new EvolveRequestStore(db); mocks.operator.mockReturnValue(true); });
  afterEach(() => { db.close(); vi.restoreAllMocks(); });
  it('authenticates locally and passes the secret only to the internal preparer', async () => {
    const request = store.create('/tmp', { intent: 'fixture', files: ['a.ts'], changes: { 'a.ts': 'hello' } });
    mocks.prompt.mockResolvedValueOnce(request.digest).mockResolvedValueOnce('synthetic-operator').mockResolvedValueOnce('synthetic-tier2');
    mocks.prepare.mockResolvedValue({ success: true, status: 'prepared', sessionId: 'fixture-session' });
    const repo = { requestStore: () => store };
    const ctx = { args: { command: 'evolve', subcommand: 'prepare', target: request.id }, argv: [],
      getContainer: () => ({ evolveSessionRepository: repo }) } as never;
    await evolveCommandHandler.handle(ctx);
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({ passphrase: 'synthetic-tier2' }), expect.anything());
    expect(store.get(request.id)).toMatchObject({ status: 'prepared', sessionId: 'fixture-session' });
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('synthetic-tier2');
  });
  it('refuses a request changed while the operator is confirming it', async () => {
    const request = store.create('/tmp', { intent: 'fixture', files: ['a.ts'], changes: { 'a.ts': 'hello' } });
    mocks.prompt.mockResolvedValueOnce(request.digest).mockResolvedValueOnce('synthetic-operator').mockImplementationOnce(async () => {
      db.prepare('UPDATE evolve_requests SET payload=? WHERE id=?').run('{}', request.id); return 'synthetic-tier2';
    });
    const ctx = { args: { command: 'evolve', subcommand: 'prepare', target: request.id }, argv: [],
      getContainer: () => ({ evolveSessionRepository: { requestStore: () => store } }) } as never;
    await expect(evolveCommandHandler.handle(ctx)).rejects.toThrow('request changed');
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
