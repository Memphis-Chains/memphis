/**
 * Bridge between the native `memphis_cron` tool's script directory and the
 * Memphis scheduler.
 *
 * WHY THIS EXISTS
 * ---------------
 * The native (Rust) `memphis_cron` tool writes a shell script into
 * `~/memphis/crons/` with a `# schedule: <cron>` header, and manages it with
 * chmod (executable = enabled). The tool had no runner: nothing ever
 * executed those scripts, and nothing ever read the header. On this host
 * five scripts sat in that directory with a schedule each, none of which
 * had run since they were written — including the one that refreshes the
 * agent-usage record the Omarchy panel reads, so the panel showed a
 * fifteen-day-old snapshot.
 *
 * The Memphis scheduler, in contrast, works: it parses cron expressions,
 * honours timezones, takes a lease per task, logs every run and reports
 * status. So the bridge registers the scripts as scheduler tasks instead of
 * inventing a second runner.
 *
 * The two surfaces keep their own contracts:
 *   - native `memphis_cron` manages the files (add / remove / enable / disable)
 *   - the scheduler executes them, on the schedule the file declares
 *
 * IDEMPOTENT BY DESIGN
 * --------------------
 * The bridge runs on a timer, so it must converge rather than accumulate:
 * a changed schedule is updated, a deleted script is unregistered, a
 * script that lost its executable bit is disabled, and every other task in
 * the store is preserved untouched.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  getNextRun,
  hostTimezone,
  loadTasks,
  parseCron,
  saveTasks,
  withTaskStoreLock,
  type ScheduledTask,
} from './scheduler.js';

/** Task ids the bridge owns. Everything else in the store is preserved. */
export const CRON_TASK_ID_PREFIX = 'crons-';

/**
 * The directory the native `memphis_cron` tool writes to. The Rust side
 * resolves it as `<HOME>/memphis/crons`, so this has to match exactly.
 */
export function resolveCronsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const home = rawEnv.HOME?.trim() || '/home/memphis';
  return join(home, 'memphis', 'crons');
}

/**
 * The cron expression a script declares, if any.
 *
 * The native tool writes `# schedule: <cron>` as the second line of the
 * file. A script without that header is not scheduled — it stays a manual
 * script, which is what `monday-admin.sh` and `tuesday-code.sh` are.
 */
export function parseCronDirective(source: string): string | undefined {
  const match = /^#\s*schedule:\s*(\S.*)$/m.exec(source);
  const cron = match?.[1]?.trim();
  return cron && cron.length > 0 ? cron : undefined;
}

export type CronScript = {
  /** File name, e.g. `memphis-usage-record.sh`. */
  file: string;
  /** Absolute path. */
  path: string;
  /** The declared cron expression, when the file declares one. */
  cron: string | undefined;
  /** The executable bit is the enable switch the native tool uses. */
  enabled: boolean;
};

export type CronScriptProblem = {
  file: string;
  reason: string;
};

/**
 * Every scheduled script in the directory, plus the ones that could not be
 * used. A script with an unparseable cron is reported, not registered: a
 * broken expression must not take the whole sync down.
 */
export function readCronScripts(cronsDir: string): {
  scripts: CronScript[];
  problems: CronScriptProblem[];
} {
  const scripts: CronScript[] = [];
  const problems: CronScriptProblem[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(cronsDir);
  } catch {
    return { scripts, problems };
  }
  for (const file of entries.sort()) {
    if (!file.endsWith('.sh')) continue;
    const path = join(cronsDir, file);
    let source: string;
    let mode: number;
    try {
      source = readFileSync(path, 'utf8');
      mode = statSync(path).mode;
    } catch (error) {
      problems.push({
        file,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const cron = parseCronDirective(source);
    if (cron !== undefined) {
      try {
        parseCron(cron);
      } catch (error) {
        problems.push({
          file,
          reason: `invalid cron expression "${cron}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
        continue;
      }
    }
    scripts.push({
      file,
      path,
      cron,
      enabled: (mode & 0o111) !== 0,
    });
  }
  return { scripts, problems };
}

/** The scheduler task a cron script maps to. */
function taskForScript(script: CronScript, timezone: string): ScheduledTask | undefined {
  if (!script.cron) return undefined;
  const id = `${CRON_TASK_ID_PREFIX}${script.file.replace(/\.sh$/, '')}`;
  return {
    schemaVersion: 2,
    id,
    cron: script.cron,
    timezone,
    name: script.file,
    command: { type: 'shell', script: `bash ${script.path}` },
    enabled: script.enabled,
    lastRun: null,
    nextRun: getNextRun(script.cron, new Date(), timezone).toISOString(),
    lastStatus: null,
    startedAt: null,
    finishedAt: null,
    lastError: null,
    lastScheduledFor: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: new Date().toISOString(),
    runCount: 0,
  };
}

export type CronSyncResult = {
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  preserved: string[];
  problems: CronScriptProblem[];
};

/**
 * Register the cron scripts as scheduler tasks.
 *
 * Converges the store onto the scripts on disk: adds what is missing,
 * updates what changed (schedule, timezone, name, command, enabled),
 * unregisters scripts that are gone, and leaves every other task alone.
 */
export function reconcileCronTasks(
  options: { apply?: boolean; cronsDir?: string; rawEnv?: NodeJS.ProcessEnv } = {},
): CronSyncResult {
  const rawEnv = options.rawEnv ?? process.env;
  const cronsDir = options.cronsDir ?? resolveCronsDir(rawEnv);
  const timezone = hostTimezone();
  const { scripts, problems } = readCronScripts(cronsDir);
  const desired = scripts
    .map((script) => taskForScript(script, timezone))
    .filter((task): task is ScheduledTask => task !== undefined);
  const desiredIds = new Set(desired.map((task) => task.id));

  const current = loadTasks();
  const currentCronIds = new Set(
    current
      .filter((task) => task.id.startsWith(CRON_TASK_ID_PREFIX))
      .map((task) => task.id),
  );

  const added = desired
    .filter((task) => !current.some((existing) => existing.id === task.id))
    .map((task) => task.id);
  const updated = desired
    .filter((task) => {
      const existing = current.find((candidate) => candidate.id === task.id);
      if (!existing) return false;
      return (
        existing.cron !== task.cron ||
        existing.timezone !== task.timezone ||
        existing.name !== task.name ||
        JSON.stringify(existing.command) !== JSON.stringify(task.command) ||
        existing.enabled !== task.enabled
      );
    })
    .map((task) => task.id);
  const removed = [...currentCronIds].filter((id) => !desiredIds.has(id));
  const preserved = current
    .filter((task) => !currentCronIds.has(task.id))
    .map((task) => task.id);

  const result: CronSyncResult = {
    changed: added.length > 0 || updated.length > 0 || removed.length > 0,
    added,
    updated,
    removed,
    preserved,
    problems,
  };
  if (!options.apply || !result.changed) return result;

  withTaskStoreLock(() => {
    const latest = loadTasks();
    const latestCronIds = new Set(
      latest
        .filter((task) => task.id.startsWith(CRON_TASK_ID_PREFIX))
        .map((task) => task.id),
    );
    const kept = latest.filter((task) => !latestCronIds.has(task.id));
    const now = new Date();
    const merged = desired.map((task) => {
      const existing = latest.find((candidate) => candidate.id === task.id);
      if (!existing) return task;
      // Keep the run history; refresh the definition and the next run.
      return {
        ...existing,
        ...task,
        nextRun: getNextRun(task.cron, now, task.timezone).toISOString(),
      };
    });
    saveTasks([...kept, ...merged]);
  });
  return result;
}

/**
 * Keep the store in sync with the scripts on disk.
 *
 * The native `memphis_cron` tool writes a script and expects it to run. A
 * script added between two syncs would otherwise wait for the next daemon
 * restart, so the bridge re-scans on a timer.
 */
export function startCronsBridge(
  options: { intervalMs?: number; cronsDir?: string; rawEnv?: NodeJS.ProcessEnv } = {},
): { stop: () => void; sync: () => CronSyncResult } {
  const intervalMs = options.intervalMs ?? 60_000;
  const sync = (): CronSyncResult => {
    try {
      return reconcileCronTasks({ apply: true, ...options });
    } catch {
      // A failed sync must not take the daemon down; the next tick retries.
      return {
        changed: false,
        added: [],
        updated: [],
        removed: [],
        preserved: [],
        problems: [],
      };
    }
  };
  sync();
  const timer = setInterval(sync, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    timer.unref();
  }
  return {
    stop: () => clearInterval(timer),
    sync,
  };
}
