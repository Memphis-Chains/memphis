import { join } from 'node:path';

import { INSTALL_JOB_TYPE } from './install-runner.js';
import {
  spawnTrainingJob,
  type SpawnTrainingJobInput,
  type TrainingExitResult,
} from './training-worker.js';
import type { SqliteScheduledJobRepository } from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';

export const TRAINING_JOB_TYPE = 'kartograf-training' as const;
export { INSTALL_JOB_TYPE };
export const TRAINING_JOB_RUNNER = 'training-job-runner';

export type TrainingPayload = Pick<
  SpawnTrainingJobInput,
  'mode' | 'corpusDir' | 'outDir' | 'signingSeedFile'
>;

export type TrainingJobRunnerResult = {
  dispatched: number;
  skipped: number;
  reason?: string;
};

export interface TrainingJobRunner {
  runOnce(): Promise<TrainingJobRunnerResult>;
}

export interface TrainingJobRunnerOptions {
  repository: SqliteScheduledJobRepository;
  rawEnv?: NodeJS.ProcessEnv;
  spawnImpl?: (input: SpawnTrainingJobInput) => {
    jobId: string;
    pid: number;
    exit: Promise<TrainingExitResult>;
    cancel(): boolean;
  };
}

function parseTrainingPayload(payload: string): TrainingPayload | null {
  try {
    const parsed = JSON.parse(payload) as Partial<TrainingPayload>;
    if (
      typeof parsed.mode !== 'string' ||
      parsed.mode.length === 0 ||
      typeof parsed.corpusDir !== 'string' ||
      parsed.corpusDir.length === 0 ||
      typeof parsed.outDir !== 'string' ||
      parsed.outDir.length === 0 ||
      typeof parsed.signingSeedFile !== 'string' ||
      parsed.signingSeedFile.length === 0
    ) {
      return null;
    }
    return {
      mode: parsed.mode,
      corpusDir: parsed.corpusDir,
      outDir: parsed.outDir,
      signingSeedFile: parsed.signingSeedFile,
    };
  } catch {
    return null;
  }
}

export function recoverStaleTrainingActive(repository: SqliteScheduledJobRepository): number {
  const active = repository
    .listByStatus('active', 1000)
    .filter((job) => job.type === TRAINING_JOB_TYPE);
  for (const job of active) {
    repository.markFailed(job.id, 'daemon-restart-during-run');
  }
  return active.length;
}

export function createTrainingJobRunner(options: TrainingJobRunnerOptions): TrainingJobRunner {
  const rawEnv = options.rawEnv ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawnTrainingJob;

  return {
    async runOnce(): Promise<TrainingJobRunnerResult> {
      if (rawEnv.MEMPHIS_NIGHTLY_RUNNER_ENABLED === '0') {
        return { dispatched: 0, skipped: 0, reason: 'feature-disabled' };
      }

      const active = options.repository
        .listByStatus('active', 1000)
        .some((job) => job.type === TRAINING_JOB_TYPE);
      if (active) {
        return { dispatched: 0, skipped: 0, reason: 'training-already-active' };
      }

      const due = options.repository
        .listDueNow()
        .filter((job) => job.type === TRAINING_JOB_TYPE)[0];
      if (!due) return { dispatched: 0, skipped: 0 };

      const payload = parseTrainingPayload(due.payload);
      if (!payload) {
        options.repository.markFailed(due.id, 'payload-parse-failed');
        return { dispatched: 0, skipped: 1, reason: 'payload-parse-failed' };
      }

      options.repository.markActive(due.id);
      const handle = spawnImpl({
        jobId: due.id,
        ...payload,
        rawEnv,
      });
      const result = await handle.exit;
      if (!result.ok) {
        options.repository.markFailed(due.id, result.reason || 'training-failed');
        return { dispatched: 1, skipped: 0 };
      }

      options.repository.markCompleted(due.id);
      options.repository.create({
        type: INSTALL_JOB_TYPE,
        payload: JSON.stringify({
          stagedEnvelopePath: join(payload.outDir, 'checkpoint.json'),
          trainingJobId: due.id,
          mode: payload.mode,
        }),
      });
      return { dispatched: 1, skipped: 0 };
    },
  };
}

export type TrainingJob = {
  type: typeof TRAINING_JOB_TYPE;
};

export type InstallJob = {
  type: typeof INSTALL_JOB_TYPE;
};
