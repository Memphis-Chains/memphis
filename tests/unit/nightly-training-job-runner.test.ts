/**
 * Training-job-runner — lifecycle (recovery, dispatch, one-at-a-time,
 * install-enqueue, failure transitions). Uses sqlite in-memory DB +
 * a stubbed spawnImpl so no real subprocess runs.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSqliteClient,
  runMigrations,
} from '../../src/infra/storage/sqlite/client.js';
import {
  SqliteScheduledJobRepository,
  type ScheduledJob,
} from '../../src/infra/storage/sqlite/repositories/scheduled-job-repository.js';
import {
  INSTALL_JOB_TYPE,
  TRAINING_JOB_TYPE,
  createTrainingJobRunner,
  recoverStaleTrainingActive,
} from '../../src/modules/nightly/training-job-runner.js';
import type {
  SpawnTrainingJobInput,
  TrainingExitResult,
} from '../../src/modules/nightly/training-worker.js';

let dbTmpDirs: string[] = [];

const makeRepo = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nightly-runner-db-'));
  dbTmpDirs.push(dir);
  const db = createSqliteClient(`file:${path.join(dir, 'test.sqlite')}`);
  runMigrations(db);
  return new SqliteScheduledJobRepository(db);
};

const validPayload = (overrides: Partial<{ mode: string }> = {}) =>
  JSON.stringify({
    mode: overrides.mode ?? 'stub',
    corpusDir: '/tmp/corpus',
    outDir: '/tmp/out',
    signingSeedFile: '/tmp/seed.bin',
  });

const makeSpawnImpl = (exitResult: TrainingExitResult) => {
  return (input: SpawnTrainingJobInput) => ({
    jobId: input.jobId,
    pid: 12345,
    exit: Promise.resolve(exitResult),
    cancel: () => true,
  });
};

describe('recoverStaleTrainingActive', () => {
  it('marks every active kartograf-training row as failed', () => {
    const repo = makeRepo();
    // 2 active training rows + 1 active row of a different type.
    const a = repo.create({ type: TRAINING_JOB_TYPE, payload: validPayload() });
    const b = repo.create({ type: TRAINING_JOB_TYPE, payload: validPayload() });
    const c = repo.create({ type: 'unrelated.task', payload: '{}' });
    repo.markActive(a.id);
    repo.markActive(b.id);
    repo.markActive(c.id);

    const recovered = recoverStaleTrainingActive(repo);
    expect(recovered).toBe(2);

    expect(repo.getById(a.id)!.status).toBe('failed');
    expect(repo.getById(a.id)!.errorMessage).toBe('daemon-restart-during-run');
    expect(repo.getById(b.id)!.status).toBe('failed');
    // Unrelated active row stays active — recovery is type-scoped.
    expect(repo.getById(c.id)!.status).toBe('active');
  });
});

describe('createTrainingJobRunner.runOnce', () => {
  let repo: SqliteScheduledJobRepository;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    repo = makeRepo();
    env = { ...process.env, MEMPHIS_NIGHTLY_RUNNER_ENABLED: '1' };
    // outDir parent existence makes the runner happier; not strictly
    // required since we override spawnImpl, but good defensive setup.
    mkdirSync('/tmp/out', { recursive: true });
  });

  afterEach(() => {
    for (const dir of dbTmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dbTmpDirs = [];
  });

  it('returns feature-disabled when MEMPHIS_NIGHTLY_RUNNER_ENABLED=0', async () => {
    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: { ...env, MEMPHIS_NIGHTLY_RUNNER_ENABLED: '0' },
      spawnImpl: makeSpawnImpl({
        ok: true,
        exitCode: 0,
        signal: null,
        reason: '',
      }),
    });
    const result = await runner.runOnce();
    expect(result.dispatched).toBe(0);
    expect(result.reason).toBe('feature-disabled');
  });

  it('refuses to start a second training when one is already active', async () => {
    const blocker = repo.create({ type: TRAINING_JOB_TYPE, payload: validPayload() });
    repo.markActive(blocker.id);

    const pending = repo.create({ type: TRAINING_JOB_TYPE, payload: validPayload() });

    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: env,
      spawnImpl: makeSpawnImpl({
        ok: true,
        exitCode: 0,
        signal: null,
        reason: '',
      }),
    });
    const result = await runner.runOnce();
    expect(result.dispatched).toBe(0);
    expect(result.reason).toBe('training-already-active');
    // Pending row stays pending — not dispatched, not failed.
    expect(repo.getById(pending.id)!.status).toBe('pending');
  });

  it('dispatches the oldest due training job and enqueues an install on success', async () => {
    const job = repo.create({
      type: TRAINING_JOB_TYPE,
      payload: validPayload({ mode: 'stub' }),
    });

    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: env,
      spawnImpl: makeSpawnImpl({
        ok: true,
        exitCode: 0,
        signal: null,
        reason: '',
      }),
    });
    const result = await runner.runOnce();
    expect(result.dispatched).toBe(1);

    const final = repo.getById(job.id)!;
    expect(final.status).toBe('completed');

    // An install row should now exist.
    const installs = repo.listByStatus('pending', 50).filter(
      (j: ScheduledJob) => j.type === INSTALL_JOB_TYPE,
    );
    expect(installs).toHaveLength(1);
    const payload = JSON.parse(installs[0].payload) as Record<string, unknown>;
    expect(payload.trainingJobId).toBe(job.id);
    expect(payload.mode).toBe('stub');
    expect(payload.stagedEnvelopePath).toBe('/tmp/out/checkpoint.json');
  });

  it('marks the job failed on a non-zero subprocess exit', async () => {
    const job = repo.create({ type: TRAINING_JOB_TYPE, payload: validPayload() });

    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: env,
      spawnImpl: makeSpawnImpl({
        ok: false,
        exitCode: 2,
        signal: null,
        reason: 'child exited with code 2',
      }),
    });
    const result = await runner.runOnce();
    expect(result.dispatched).toBe(1);

    const final = repo.getById(job.id)!;
    expect(final.status).toBe('failed');
    expect(final.errorMessage).toBe('child exited with code 2');

    // No install row enqueued on failure.
    const installs = repo
      .listByStatus(undefined, 50)
      .filter((j: ScheduledJob) => j.type === INSTALL_JOB_TYPE);
    expect(installs).toHaveLength(0);
  });

  it('marks the job failed when the payload is unparseable', async () => {
    const job = repo.create({ type: TRAINING_JOB_TYPE, payload: '{"mode":"banana"}' });

    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: env,
      spawnImpl: makeSpawnImpl({
        ok: true,
        exitCode: 0,
        signal: null,
        reason: '',
      }),
    });
    const result = await runner.runOnce();
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.reason).toBe('payload-parse-failed');

    expect(repo.getById(job.id)!.status).toBe('failed');
    expect(repo.getById(job.id)!.errorMessage).toBe('payload-parse-failed');
  });

  it('returns dispatched=0 with no reason when there are no due training jobs', async () => {
    const runner = createTrainingJobRunner({
      repository: repo,
      rawEnv: env,
      spawnImpl: makeSpawnImpl({
        ok: true,
        exitCode: 0,
        signal: null,
        reason: '',
      }),
    });
    const result = await runner.runOnce();
    expect(result).toEqual({ dispatched: 0, skipped: 0 });
  });
});
