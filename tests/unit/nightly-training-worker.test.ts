/**
 * Training-worker spawn + cancel + registry semantics.
 *
 * Uses a tiny `python3 -c` script as the child so the test exercises
 * the real spawn path without depending on the full Kartograf trainer.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  __resetTrainingRegistryForTests,
  cancelTrainingJob,
  getStatusFilePath,
  listLiveTrainingJobs,
  spawnTrainingJob,
} from '../../src/modules/nightly/training-worker.js';

const HAS_PYTHON = (() => {
  try {
    const r = spawnSync('python3', ['--version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
})();

const describeWithPython = HAS_PYTHON ? describe : describe.skip;

describeWithPython('spawnTrainingJob', () => {
  let tmpDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-worker-test-'));
    env = {
      ...process.env,
      MEMPHIS_DATA_DIR: tmpDir,
      MEMPHIS_INSTALL_ROOT: '/home/memphis/memphis',
    };
    __resetTrainingRegistryForTests();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    __resetTrainingRegistryForTests();
  });

  it('getStatusFilePath resolves under <dataDir>/state', () => {
    const p = getStatusFilePath(env);
    expect(p).toContain('state');
    expect(p.endsWith('kartograf-training.json')).toBe(true);
  });

  it('registers a live child and unregisters on close', async () => {
    // Stand in for the trainer with a python3 process that exits 0.
    // We point `--out` at a tmp dir + supply throwaway corpus/seed so
    // the trainer-script command shape is honoured even though we
    // never actually run train-kartograf.py (handle.exit short-circuits
    // because the script path won't have the corpus files).
    //
    // The real assertion is `liveChildren` bookkeeping: the registry
    // should track the spawned child until `close` fires.
    const corpusDir = path.join(tmpDir, 'corpus');
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.writeFileSync(
      path.join(corpusDir, 'corpus-v1-summary.json'),
      JSON.stringify({
        corpus_version: 'v1',
        source_count: 1,
        secret_scan: { clean: true },
        vault_denylist: { enforced: true },
      }),
    );
    fs.writeFileSync(path.join(corpusDir, 'train.jsonl'), 'data\n');
    const seedFile = path.join(tmpDir, 'seed.bin');
    fs.writeFileSync(seedFile, Buffer.alloc(32, 0x42));

    const handle = spawnTrainingJob({
      jobId: 'test-job-1',
      mode: 'stub',
      corpusDir,
      outDir: path.join(tmpDir, 'out'),
      signingSeedFile: seedFile,
      rawEnv: env,
    });

    expect(handle.pid).toBeGreaterThan(0);
    expect(listLiveTrainingJobs()).toContainEqual({
      jobId: 'test-job-1',
      pid: handle.pid,
    });

    const result = await handle.exit;
    expect(result).toHaveProperty('ok');
    // After close the registry is empty again.
    expect(listLiveTrainingJobs()).toHaveLength(0);
  });

  it('cancelTrainingJob SIGTERMs a live child', async () => {
    const corpusDir = path.join(tmpDir, 'corpus');
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.writeFileSync(
      path.join(corpusDir, 'corpus-v1-summary.json'),
      JSON.stringify({
        corpus_version: 'v1',
        source_count: 1,
        secret_scan: { clean: true },
        vault_denylist: { enforced: true },
      }),
    );
    fs.writeFileSync(path.join(corpusDir, 'train.jsonl'), 'data\n');
    const seedFile = path.join(tmpDir, 'seed.bin');
    fs.writeFileSync(seedFile, Buffer.alloc(32, 0x42));

    const handle = spawnTrainingJob({
      jobId: 'test-job-cancel',
      mode: 'stub',
      corpusDir,
      outDir: path.join(tmpDir, 'out-cancel'),
      signingSeedFile: seedFile,
      rawEnv: env,
    });

    // Cancel immediately and assert the exit promise resolves with a
    // non-ok result (signal or non-zero exit).
    const canceled = cancelTrainingJob('test-job-cancel');
    expect(canceled).toBe(true);

    const result = await handle.exit;
    expect(result.ok).toBe(false);
    // Second cancel returns false (single-shot semantics).
    expect(cancelTrainingJob('test-job-cancel')).toBe(false);
  });

  it('cancelTrainingJob returns false for unknown jobId', () => {
    expect(cancelTrainingJob('does-not-exist')).toBe(false);
  });
});
