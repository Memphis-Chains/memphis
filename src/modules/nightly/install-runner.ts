import type { SqliteScheduledJobRepository } from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';

export const INSTALL_JOB_TYPE = 'kartograf-install' as const;

export interface InstallPayload {
  stagedEnvelopePath: string;
  trainingJobId: string;
  mode: string;
}

export interface InstallDecision {
  acceptInstall: boolean;
  reason: 'no-prior-checkpoint' | 'eval-improved' | 'eval-tied' | 'regression-rejected';
  newEval: number;
  currentEval: number | null;
  threshold: number;
}

export function decideInstall(
  newEval: number,
  currentEval: number | null,
  threshold: number,
): InstallDecision {
  if (currentEval === null) {
    return {
      acceptInstall: true,
      reason: 'no-prior-checkpoint',
      newEval,
      currentEval,
      threshold,
    };
  }
  if (newEval > currentEval) {
    return {
      acceptInstall: true,
      reason: 'eval-improved',
      newEval,
      currentEval,
      threshold,
    };
  }
  const acceptInstall = newEval >= currentEval * threshold;
  return {
    acceptInstall,
    reason: acceptInstall ? 'eval-tied' : 'regression-rejected',
    newEval,
    currentEval,
    threshold,
  };
}

export function parsePayload(payload: string): InstallPayload | null {
  try {
    const parsed = JSON.parse(payload) as Partial<InstallPayload>;
    if (
      typeof parsed.stagedEnvelopePath !== 'string' ||
      parsed.stagedEnvelopePath.length === 0 ||
      typeof parsed.trainingJobId !== 'string' ||
      parsed.trainingJobId.length === 0 ||
      typeof parsed.mode !== 'string' ||
      parsed.mode.length === 0
    ) {
      return null;
    }
    return {
      stagedEnvelopePath: parsed.stagedEnvelopePath,
      trainingJobId: parsed.trainingJobId,
      mode: parsed.mode,
    };
  } catch {
    return null;
  }
}

export function recoverStaleInstallActive(repository: SqliteScheduledJobRepository): number {
  const active = repository
    .listByStatus('active', 1000)
    .filter((job) => job.type === INSTALL_JOB_TYPE);
  for (const job of active) {
    repository.markFailed(job.id, 'daemon-restart-during-install');
  }
  return active.length;
}

