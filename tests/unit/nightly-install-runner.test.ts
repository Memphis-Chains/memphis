/**
 * Install-runner — eval-gate decision logic + payload parsing +
 * stale-active recovery.
 *
 * Full end-to-end install (envelope verify + slug-dir mutation +
 * runtime singleton reload + auto-rollback) is exercised via the
 * Phase 9 integration test where the Kartograf runtime is stubbed.
 * Here we lock in the decision predicates that drive every install
 * path.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSqliteClient,
  runMigrations,
} from '../../src/infra/storage/sqlite/client.js';
import { SqliteScheduledJobRepository } from '../../src/infra/storage/sqlite/repositories/scheduled-job-repository.js';
import {
  INSTALL_JOB_TYPE,
  decideInstall,
  parsePayload,
  recoverStaleInstallActive,
} from '../../src/modules/nightly/install-runner.js';

describe('decideInstall (eval-gate)', () => {
  it('accepts when no prior checkpoint exists', () => {
    const d = decideInstall(0.0, null, 0.95);
    expect(d.acceptInstall).toBe(true);
    expect(d.reason).toBe('no-prior-checkpoint');
  });

  it('accepts when new equals current (eval-tied)', () => {
    const d = decideInstall(0.4, 0.4, 0.95);
    expect(d.acceptInstall).toBe(true);
    expect(d.reason).toBe('eval-tied');
  });

  it('accepts when new exceeds current (eval-improved)', () => {
    const d = decideInstall(0.5, 0.4, 0.95);
    expect(d.acceptInstall).toBe(true);
    expect(d.reason).toBe('eval-improved');
  });

  it('accepts a small drop inside the threshold band', () => {
    // current 0.50, threshold 0.95 → floor = 0.475. new=0.48 ≥ floor.
    const d = decideInstall(0.48, 0.5, 0.95);
    expect(d.acceptInstall).toBe(true);
    expect(d.reason).toBe('eval-tied'); // not improved, not rejected
  });

  it('rejects when new falls below the threshold band', () => {
    // current 0.50, threshold 0.95 → floor = 0.475. new=0.47 < floor.
    const d = decideInstall(0.47, 0.5, 0.95);
    expect(d.acceptInstall).toBe(false);
    expect(d.reason).toBe('regression-rejected');
  });

  it('honours a stricter threshold', () => {
    // current 0.50, threshold 0.99 → floor = 0.495.
    expect(decideInstall(0.495, 0.5, 0.99).acceptInstall).toBe(true);
    expect(decideInstall(0.494, 0.5, 0.99).acceptInstall).toBe(false);
  });

  it('records the threshold + values used in the decision', () => {
    const d = decideInstall(0.42, 0.5, 0.9);
    expect(d.newEval).toBe(0.42);
    expect(d.currentEval).toBe(0.5);
    expect(d.threshold).toBe(0.9);
  });
});

describe('parsePayload', () => {
  it('returns the parsed payload when fields are valid', () => {
    const p = parsePayload(
      JSON.stringify({
        stagedEnvelopePath: '/tmp/out/checkpoint.json',
        trainingJobId: 'train-1',
        mode: 'smoke',
      }),
    );
    expect(p).toEqual({
      stagedEnvelopePath: '/tmp/out/checkpoint.json',
      trainingJobId: 'train-1',
      mode: 'smoke',
    });
  });

  it('returns null on missing required fields', () => {
    expect(parsePayload(JSON.stringify({ trainingJobId: 'x' }))).toBeNull();
    expect(parsePayload(JSON.stringify({ stagedEnvelopePath: '' }))).toBeNull();
  });

  it('returns null on unparseable JSON', () => {
    expect(parsePayload('not-json')).toBeNull();
  });
});

describe('recoverStaleInstallActive', () => {
  let dbDir: string;
  let repo: SqliteScheduledJobRepository;

  beforeEach(() => {
    dbDir = mkdtempSync(path.join(os.tmpdir(), 'install-recovery-'));
    const db = createSqliteClient(`file:${path.join(dbDir, 'test.sqlite')}`);
    runMigrations(db);
    repo = new SqliteScheduledJobRepository(db);
  });

  afterEach(() => {
    rmSync(dbDir, { recursive: true, force: true });
  });

  it('marks active kartograf-install rows as failed but leaves others', () => {
    const installA = repo.create({
      type: INSTALL_JOB_TYPE,
      payload: JSON.stringify({
        stagedEnvelopePath: '/tmp/out/checkpoint.json',
        trainingJobId: 't-1',
        mode: 'smoke',
      }),
    });
    const installB = repo.create({
      type: INSTALL_JOB_TYPE,
      payload: JSON.stringify({
        stagedEnvelopePath: '/tmp/out2/checkpoint.json',
        trainingJobId: 't-2',
        mode: 'full',
      }),
    });
    const unrelated = repo.create({ type: 'unrelated.task', payload: '{}' });

    repo.markActive(installA.id);
    repo.markActive(installB.id);
    repo.markActive(unrelated.id);

    const recovered = recoverStaleInstallActive(repo);
    expect(recovered).toBe(2);

    expect(repo.getById(installA.id)!.status).toBe('failed');
    expect(repo.getById(installA.id)!.errorMessage).toBe('daemon-restart-during-install');
    expect(repo.getById(installB.id)!.status).toBe('failed');
    expect(repo.getById(unrelated.id)!.status).toBe('active');
  });
});
