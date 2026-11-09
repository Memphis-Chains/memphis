import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';

import { evolveCommandHandler } from '../../src/infra/cli/handlers/evolve.handler.js';
import { inspectEvolveReview, mergeEvolveReview, reconcileEvolveReview } from '../../src/infra/runtime/evolve-review.js';
import { resetInstallRootMemoForTests } from '../../src/infra/runtime/install-root.js';
import { runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteEvolveSessionRepository } from '../../src/infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';

vi.mock('../../src/mcp/tools/self-governance-status.js', () => ({ runMemphisSelfGovernanceStatus: vi.fn().mockResolvedValue({ canSelfModify: true, blockingReasons: [] }) }));
vi.mock('../../src/soul/manifest.js', () => ({ ensureSoulManifest: vi.fn(), loadSoulManifest: () => ({ evolution: {
  passphraseHash: createHash('sha256').update('synthetic-tier2').digest('hex') } }) }));
vi.mock('../../src/infra/test-gate.js', () => ({ runTestGate: vi.fn().mockResolvedValue({ passed: true, steps: [{ name: 'fixture', passed: true }] }) }));
vi.mock('../../src/core/decision-history-store.js', () => ({ recordDecisionHistoryEntry: vi.fn().mockResolvedValue({ chainRef: { index: 1, hash: 'fixture' } }) }));
vi.mock('../../src/security/runtime-security-events.js', () => ({ emitRuntimeSecurityEvent: vi.fn() }));

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

it('prepares a separate reviewable commit, rejects drift, and applies only after exact confirmation', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memphis-evolve-integration-'));
  const root = join(tmp, 'repo'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic Operator');
  git(root, 'config', 'user.email', 'synthetic@example.invalid');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), 'before\n');
  writeFileSync(join(root, 'package.json'), '{"name":"@memphis-chains/memphis"}\n');
  git(root, 'add', '--', 'src/a.ts', 'package.json');
  git(root, 'commit', '-q', '-m', 'test(runtime): create synthetic fixture', '-m', 'Co-authored-by: Synthetic Operator <synthetic@example.invalid>');
  const base = git(root, 'rev-parse', 'HEAD');
  const dbPath = join(tmp, 'review.sqlite');
  const db = new Database(dbPath); runMigrations(db);
  const sessions = new SqliteEvolveSessionRepository(db);
  const result = await runMemphisSelfModify({ intent: 'synthetic change', files: ['src/a.ts'],
    changes: { 'src/a.ts': 'after\n' }, passphrase: 'synthetic-tier2' }, {
    sessionRepo: sessions, rollback: { createSnapshot: async () => 'fixture-snapshot' },
    caseAdapter: {}, projectRoot: root, rawEnv: { MEMPHIS_DATA_DIR: join(tmp, 'data') },
  } as unknown as Parameters<typeof runMemphisSelfModify>[1]);
  expect(result.status).toBe('prepared');
  expect(git(root, 'rev-parse', 'HEAD')).toBe(base);
  expect(git(root, 'branch', '--show-current')).toBe('main');
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('before\n');
  const store = sessions.reviewStore();
  const review = store.get(result.sessionId)!;
  expect(review.status).toBe('prepared');
  expect(await inspectEvolveReview(review, root)).toContain('+after');
  vi.stubEnv('MEMPHIS_RUNTIME_ROOT', root); resetInstallRootMemoForTests();
  const capture = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const ctx = { args: { command: 'evolve', subcommand: 'approve', target: review.sessionId },
      argv: [], getContainer: () => ({ evolveSessionRepository: sessions }) } as never;
    await expect(evolveCommandHandler.handle(ctx)).rejects.toThrow('requires a local interactive terminal');
    expect(store.get(review.sessionId)?.status).toBe('prepared');
  } finally { capture.mockRestore(); vi.unstubAllEnvs(); resetInstallRootMemoForTests(); }
  expect(git(review.worktree, 'log', '-1', '--format=%B')).toContain('Co-authored-by: Synthetic Operator <synthetic@example.invalid>');
  git(root, 'update-ref', `refs/heads/${review.branch}`, base);
  await expect(inspectEvolveReview(review, root)).rejects.toThrow('branch changed');
  git(root, 'update-ref', `refs/heads/${review.branch}`, review.commit);
  await expect(mergeEvolveReview(store, review.sessionId, root, 'wrong')).rejects.toThrow('does not match');
  writeFileSync(join(root, 'src', 'a.ts'), 'operator work\n');
  await expect(mergeEvolveReview(store, review.sessionId, root, review.commit)).rejects.toThrow('dirty');
  writeFileSync(join(root, 'src', 'a.ts'), 'before\n');
  const bin = join(tmp, 'bin'); mkdirSync(bin);
  copyFileSync(join(process.cwd(), 'tests/fixtures/evolve-kill-git.py'), join(bin, 'git'));
  chmodSync(join(bin, 'git'), 0o700);
  const killAt = async (phase: string) => {
    const marker = join(tmp, `marker-${phase}`);
    writeFileSync(join(bin, 'phase'), phase);
    writeFileSync(join(bin, 'marker-path'), marker);
    const code = `import Database from 'better-sqlite3';
      import {EvolveReviewStore,mergeEvolveReview} from './src/infra/runtime/evolve-review.ts';
      const [db,id,root,commit]=process.argv.slice(1);
      await mergeEvolveReview(new EvolveReviewStore(new Database(db)),id,root,commit);`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code,
      dbPath, review.sessionId, root, review.commit], { cwd: process.cwd(), detached: true,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
    const exit = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    try {
      const deadline = Date.now() + 15_000;
      while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!existsSync(marker)) throw new Error(`kill point ${phase} not reached: ${stderr}`);
    } finally {
      if (child.pid && child.exitCode === null) process.kill(-child.pid, 'SIGKILL');
      await exit;
    }
  };
  await killAt('before');
  expect(store.get(review.sessionId)?.status).toBe('merging');
  expect(await reconcileEvolveReview(store, review.sessionId, root)).toBe('prepared');
  await killAt('after');
  expect(store.get(review.sessionId)?.status).toBe('merging');
  expect(await reconcileEvolveReview(store, review.sessionId, root)).toBe('merged');
  expect(store.get(review.sessionId)?.status).toBe('merged');
  expect(store.events(review.sessionId).map((event) => event.action)).toEqual([
    'prepared', 'prepared->merging', 'merging->prepared', 'prepared->merging', 'merging->merged',
  ]);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(review.commit);
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('after\n');
  await expect(mergeEvolveReview(store, review.sessionId, root, review.commit)).rejects.toThrow('not prepared');
  db.close();
}, 30_000);

it('refuses a commit hook that adds an unreviewed file and leaves the target untouched', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'memphis-evolve-hook-'));
  const root = join(tmp, 'repo'); mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Synthetic Operator'); git(root, 'config', 'user.email', 'synthetic@example.invalid');
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src', 'a.ts'), 'before\n');
  git(root, 'add', '--', 'src/a.ts');
  git(root, 'commit', '-q', '-m', 'test(runtime): create synthetic fixture', '-m', 'Co-authored-by: Synthetic Operator <synthetic@example.invalid>');
  const hook = join(root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, '#!/bin/sh\nprintf "unreviewed\\n" > src/extra.ts\ngit add src/extra.ts\n'); chmodSync(hook, 0o700);
  const db = new Database(':memory:'); runMigrations(db);
  const sessions = new SqliteEvolveSessionRepository(db);
  const result = await runMemphisSelfModify({ intent: 'synthetic', files: ['src/a.ts'],
    changes: { 'src/a.ts': 'after\n' }, passphrase: 'synthetic-tier2' }, {
    sessionRepo: sessions, rollback: { createSnapshot: async () => 'fixture' }, caseAdapter: {},
    projectRoot: root, rawEnv: { MEMPHIS_DATA_DIR: join(tmp, 'data') },
  } as unknown as Parameters<typeof runMemphisSelfModify>[1]);
  expect(result.success).toBe(false);
  expect(result.rollbackReason).toContain('commit does not match');
  expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('before\n');
  expect(existsSync(join(root, 'src', 'extra.ts'))).toBe(false);
  expect(sessions.reviewStore().get(result.sessionId)).toBeNull();
  db.close();
}, 30_000);
