/** Persisted status contract shared by execution and diagnostics. */
export const SCHEDULER_TASK_STATUSES = [
  'pending',
  'running',
  'success',
  'failed',
  'skipped',
  'timed_out',
] as const;
export type SchedulerTaskStatus = (typeof SCHEDULER_TASK_STATUSES)[number];
export function isSchedulerTaskStatus(value: unknown): value is SchedulerTaskStatus {
  return (
    typeof value === 'string' && (SCHEDULER_TASK_STATUSES as readonly string[]).includes(value)
  );
}
