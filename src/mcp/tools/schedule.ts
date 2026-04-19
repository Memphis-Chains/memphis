// Re-export repository from canonical storage location
export { SqliteScheduledJobRepository } from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';
export type {
  JobStatus,
  ScheduledJob,
  ScheduleCreateInput,
} from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';

// Local imports for use within this module
import { SqliteScheduledJobRepository } from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';
import type {
  JobStatus,
  ScheduledJob,
  ScheduleCreateInput,
} from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';

// ─── MCP tool input/output types ────────────────────────────────────

export interface ScheduleCreateOutput {
  created: boolean;
  id: string;
  scheduledAt?: string;
  error?: string;
}

export interface ScheduleListInput {
  status?: JobStatus;
  limit?: number;
}

export interface ScheduleListOutput {
  count: number;
  jobs: ScheduledJob[];
}

export interface ScheduleCancelInput {
  id: string;
}

export interface ScheduleCancelOutput {
  canceled: boolean;
  id: string;
  error?: string;
}

// ─── MCP tool handlers ──────────────────────────────────────────────

export function runMemphisScheduleCreate(
  input: ScheduleCreateInput,
  repo: SqliteScheduledJobRepository,
): ScheduleCreateOutput {
  try {
    const job = repo.create(input);
    return {
      created: true,
      id: job.id,
      scheduledAt: new Date(job.scheduledAtMs).toISOString(),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { created: false, id: '', error: msg };
  }
}

export function runMemphisScheduleList(
  input: ScheduleListInput,
  repo: SqliteScheduledJobRepository,
): ScheduleListOutput {
  const jobs = repo.listByStatus(input.status, input.limit ?? 50);
  return { count: jobs.length, jobs };
}

export function runMemphisScheduleCancel(
  input: ScheduleCancelInput,
  repo: SqliteScheduledJobRepository,
): ScheduleCancelOutput {
  const canceled = repo.cancel(input.id);
  if (!canceled) {
    return { canceled: false, id: input.id, error: 'Job not found or not in cancelable state' };
  }
  return { canceled: true, id: input.id };
}
