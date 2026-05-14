/**
 * Training-proposer — autonomous decision to enqueue a Kartograf
 * training run. Mirrors the reflection-loop pattern
 * (`src/infra/runtime/reflection-loop.ts:241-327`): class with
 * start/stop/runOnce/tick, env-driven interval, in-flight guard,
 * `runCycle?` test seam.
 *
 * Decision tree (in order):
 *
 *   1. Feature gate. `MEMPHIS_TRAINING_PROPOSE_ENABLED` defaults to
 *      `false` so unset env = no autonomous actions; operator opts in
 *      explicitly before the proposer wakes up.
 *
 *   2. Operator-quiet gate. All registered surfaces must be `stale`
 *      (no activity within `DEFAULT_STALE_MS`, per
 *      `src/core/surface-presence.ts:14`) AND the longest-quiet
 *      surface must exceed `MEMPHIS_TRAINING_QUIET_MS` (default 2 h).
 *      Idle is necessary because training pegs the GPU; we don't want
 *      to interfere with the operator's session.
 *
 *   3. Corpus freshness. If
 *      `<dataDir>/kartograf/corpus/corpus-v1-summary.json` is missing
 *      or older than `MEMPHIS_TRAINING_CORPUS_STALE_MS` (default 7 d),
 *      emit a `corpus_proposal` insights block and STOP. `kartograf-corpus.py`
 *      is a build-time tool — the proposer surfaces "rebuild corpus"
 *      to the operator rather than running the script autonomously.
 *
 *   4. Active-job gate. If any `pending` or `active`
 *      `kartograf-training` row exists, skip — the training-job-runner
 *      will dispatch it on its own cadence.
 *
 *   5. Cooldown. The most recent `completed` `kartograf-training` row
 *      must be at least `MEMPHIS_TRAINING_PROPOSE_AGE_MS` (default 7 d)
 *      old. Prevents back-to-back trainings on small corpus changes.
 *
 *   6. Daily Telegram rate-limit. The proposer's lifecycle event
 *      (insights block + Telegram ping via existing
 *      `subscribeTier3Lifecycle`-style chains) records a proposal-id
 *      key `nightly-training-<YYYY-MM-DD>` in the
 *      `SeenProposalRepository`. If today's key is already seen, the
 *      enqueue still happens but the operator-visible ping is
 *      suppressed.
 *
 * When all gates pass, the proposer:
 *
 *   - Creates a new `kartograf-training` row via
 *     `repository.create({ type, payload, delayMs: 0 })`.
 *   - Emits an `insight` block of `kind: 'training_proposed_and_started'`
 *     to the `insights` chain so the operator sees the decision in
 *     `memphis_recall` + `memphis_search`.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  INSTALL_JOB_TYPE,
  TRAINING_JOB_TYPE,
} from './training-job-runner.js';
import { getDataDir } from '../../config/paths.js';
import {
  DEFAULT_STALE_MS,
  getActiveSurfacesSnapshot,
  type SurfaceActivitySnapshot,
} from '../../core/surface-presence.js';
import { createPinoLogger } from '../../infra/logging/pino.js';
import { appendBlock } from '../../infra/storage/chain-adapter.js';
import {
  SqliteScheduledJobRepository,
  type ScheduledJob,
} from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';
import { SeenProposalRepository } from '../../infra/storage/sqlite/repositories/seen-proposal-repository.js';

const log = createPinoLogger({ level: process.env.LOG_LEVEL ?? 'info' });

const DEFAULT_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_INITIAL_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_QUIET_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_CORPUS_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_PROPOSE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type ProposerDecisionKind =
  | 'feature-disabled'
  | 'operator-active'
  | 'corpus-stale'
  | 'training-already-queued'
  | 'cooldown-active'
  | 'training-proposed-and-started';

export interface ProposerDecision {
  kind: ProposerDecisionKind;
  message: string;
  /** When kind === 'training-proposed-and-started', the new row id. */
  jobId?: string;
  /** Diagnostic metadata; surfaced in insights block + audit. */
  metadata: Record<string, unknown>;
}

export interface TrainingProposerOptions {
  repository: SqliteScheduledJobRepository;
  seenProposals: SeenProposalRepository;
  rawEnv?: NodeJS.ProcessEnv;
  intervalMs?: number;
  initialDelayMs?: number;
  /** Test seam — overrides surface presence reading. */
  presenceSnapshot?: () => SurfaceActivitySnapshot[];
  /** Test seam — overrides clock for cooldown math. */
  clock?: () => number;
  /** Test seam — overrides decision execution. */
  runCycle?: (deps: TrainingProposerDeps) => Promise<ProposerDecision>;
}

export interface TrainingProposerDeps {
  repository: SqliteScheduledJobRepository;
  seenProposals: SeenProposalRepository;
  rawEnv: NodeJS.ProcessEnv;
  presenceSnapshot: () => SurfaceActivitySnapshot[];
  clock: () => number;
}

export interface TrainingProposerHandle {
  start(): void;
  stop(): Promise<void>;
  runOnce(): Promise<ProposerDecision>;
  isRunning(): boolean;
}

function isFeatureEnabled(rawEnv: NodeJS.ProcessEnv): boolean {
  const flag = (rawEnv.MEMPHIS_TRAINING_PROPOSE_ENABLED ?? '').trim();
  if (!flag) return false;
  return flag !== '0' && flag.toLowerCase() !== 'false';
}

function readMsEnv(
  rawEnv: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = (rawEnv[key] ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function corpusSummaryPath(rawEnv: NodeJS.ProcessEnv): string {
  return join(
    getDataDir(rawEnv),
    'kartograf',
    'corpus',
    'corpus-v1-summary.json',
  );
}

function corpusMtimeMs(rawEnv: NodeJS.ProcessEnv): number | null {
  const p = corpusSummaryPath(rawEnv);
  if (!existsSync(p)) return null;
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function isodate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function findExistingTrainingRow(
  repo: SqliteScheduledJobRepository,
): ScheduledJob | null {
  for (const status of ['pending', 'active'] as const) {
    const rows = repo.listByStatus(status, 50);
    const match = rows.find((row) => row.type === TRAINING_JOB_TYPE);
    if (match) return match;
  }
  return null;
}

function findLastCompletedTraining(
  repo: SqliteScheduledJobRepository,
): ScheduledJob | null {
  const rows = repo.listByStatus('completed', 200);
  return (
    rows
      .filter((row) => row.type === TRAINING_JOB_TYPE)
      .sort((a, b) => b.scheduledAtMs - a.scheduledAtMs)[0] ?? null
  );
}

function buildTrainingPayload(rawEnv: NodeJS.ProcessEnv, mode: 'smoke' | 'full'): string {
  const dataDir = getDataDir(rawEnv);
  return JSON.stringify({
    mode,
    corpusDir: join(dataDir, 'kartograf', 'corpus'),
    outDir: join(dataDir, 'kartograf', 'staged', isodate(Date.now())),
    signingSeedFile: join(dataDir, 'kartograf', 'signing-seed.bin'),
  });
}

async function emitInsightsBlock(
  kind: string,
  content: string,
  metadata: Record<string, unknown>,
  rawEnv: NodeJS.ProcessEnv,
): Promise<void> {
  try {
    await appendBlock(
      'insights',
      {
        type: 'insight',
        kind,
        schemaVersion: 1,
        source: 'nightly-training-proposer',
        content,
        tags: ['insight', 'nightly', kind],
        metadata,
      },
      rawEnv,
    );
  } catch (err) {
    log.warn(
      { kind, err: err instanceof Error ? err.message : String(err) },
      'training-proposer: insights emit failed',
    );
  }
}

async function defaultRunCycle(
  deps: TrainingProposerDeps,
): Promise<ProposerDecision> {
  if (!isFeatureEnabled(deps.rawEnv)) {
    return {
      kind: 'feature-disabled',
      message: 'MEMPHIS_TRAINING_PROPOSE_ENABLED not set',
      metadata: {},
    };
  }

  const now = deps.clock();

  // Operator-quiet gate.
  const snapshots = deps.presenceSnapshot();
  const quietMs = readMsEnv(deps.rawEnv, 'MEMPHIS_TRAINING_QUIET_MS', DEFAULT_QUIET_MS);
  const allStale = snapshots.every((s) => s.stale);
  const longestQuiet = snapshots.length === 0
    ? Number.POSITIVE_INFINITY
    : Math.max(...snapshots.map((s) => s.ageMs));
  if (!allStale || longestQuiet < quietMs) {
    return {
      kind: 'operator-active',
      message: `operator active or below quiet threshold (${quietMs} ms)`,
      metadata: {
        allStale,
        longestQuietMs: Number.isFinite(longestQuiet) ? longestQuiet : null,
        requiredQuietMs: quietMs,
        surfaces: snapshots.map((s) => ({ surface: s.surface, stale: s.stale, ageMs: s.ageMs })),
      },
    };
  }

  // Corpus freshness.
  const corpusStaleMs = readMsEnv(
    deps.rawEnv,
    'MEMPHIS_TRAINING_CORPUS_STALE_MS',
    DEFAULT_CORPUS_STALE_MS,
  );
  const corpusMtime = corpusMtimeMs(deps.rawEnv);
  if (corpusMtime === null || now - corpusMtime > corpusStaleMs) {
    const proposalId = `nightly-corpus-${isodate(now)}`;
    const alreadyPinged = deps.seenProposals.has(proposalId);
    deps.seenProposals.record(proposalId);
    const metadata = {
      corpusSummaryPath: corpusSummaryPath(deps.rawEnv),
      corpusMtimeMs: corpusMtime,
      corpusStaleMs,
      requiredFreshness: 'corpus < 7d old',
      alreadyPinged,
    };
    if (!alreadyPinged) {
      await emitInsightsBlock(
        'corpus_proposal',
        `Kartograf corpus is stale (or missing). Run \`python3 tools/training/kartograf-corpus.py\` to refresh before the next training proposal.`,
        metadata,
        deps.rawEnv,
      );
    }
    return {
      kind: 'corpus-stale',
      message: 'corpus summary missing or older than threshold',
      metadata,
    };
  }

  // Active-job gate.
  const existing = findExistingTrainingRow(deps.repository);
  if (existing) {
    return {
      kind: 'training-already-queued',
      message: `existing training row status=${existing.status}`,
      metadata: { existingJobId: existing.id, existingStatus: existing.status },
    };
  }

  // Cooldown.
  const proposeAgeMs = readMsEnv(
    deps.rawEnv,
    'MEMPHIS_TRAINING_PROPOSE_AGE_MS',
    DEFAULT_PROPOSE_AGE_MS,
  );
  const lastCompleted = findLastCompletedTraining(deps.repository);
  if (lastCompleted && now - lastCompleted.scheduledAtMs < proposeAgeMs) {
    return {
      kind: 'cooldown-active',
      message: 'last completed training is younger than cooldown threshold',
      metadata: {
        lastJobId: lastCompleted.id,
        lastScheduledAtMs: lastCompleted.scheduledAtMs,
        cooldownMs: proposeAgeMs,
      },
    };
  }

  // All gates passed — enqueue + emit.
  const payload = buildTrainingPayload(deps.rawEnv, 'smoke');
  const created = deps.repository.create({
    type: TRAINING_JOB_TYPE,
    payload,
    delayMs: 0,
  });
  const proposalId = `nightly-training-${isodate(now)}`;
  const alreadyPinged = deps.seenProposals.has(proposalId);
  deps.seenProposals.record(proposalId);

  const metadata = {
    jobId: created.id,
    mode: 'smoke',
    queuedAtMs: now,
    cooldownMs: proposeAgeMs,
    quietMs,
    longestQuietMs: longestQuiet,
    surfaces: snapshots.map((s) => ({ surface: s.surface, ageMs: s.ageMs })),
    alreadyPinged,
    // The install-runner will pick up the resulting envelope and
    // emit `install_succeeded` / `install_rejected` insights.
    followsUpWith: INSTALL_JOB_TYPE,
  };
  if (!alreadyPinged) {
    await emitInsightsBlock(
      'training_proposed_and_started',
      `Memphis enqueued a Kartograf smoke training run (job ${created.id}). The install-runner will eval-gate the result automatically.`,
      metadata,
      deps.rawEnv,
    );
  }
  return {
    kind: 'training-proposed-and-started',
    message: 'enqueued kartograf-training row',
    jobId: created.id,
    metadata,
  };
}

export function createTrainingProposer(
  options: TrainingProposerOptions,
): TrainingProposerHandle {
  const rawEnv = options.rawEnv ?? process.env;
  const intervalMs =
    options.intervalMs ??
    readMsEnv(rawEnv, 'MEMPHIS_TRAINING_PROPOSE_INTERVAL_MS', DEFAULT_TICK_INTERVAL_MS);
  const initialDelayMs =
    options.initialDelayMs ??
    readMsEnv(
      rawEnv,
      'MEMPHIS_TRAINING_PROPOSE_INITIAL_DELAY_MS',
      DEFAULT_INITIAL_DELAY_MS,
    );
  const presenceSnapshot =
    options.presenceSnapshot ??
    (() => getActiveSurfacesSnapshot({ staleMs: DEFAULT_STALE_MS }));
  const clock = options.clock ?? (() => Date.now());
  const runCycle = options.runCycle ?? defaultRunCycle;
  const deps: TrainingProposerDeps = {
    repository: options.repository,
    seenProposals: options.seenProposals,
    rawEnv,
    presenceSnapshot,
    clock,
  };

  let timer: NodeJS.Timeout | null = null;
  let initialTimer: NodeJS.Timeout | null = null;
  let inFlight = false;
  let started = false;

  async function tick(): Promise<ProposerDecision> {
    if (inFlight) {
      return {
        kind: 'training-already-queued',
        message: 'proposer tick overlapped — skipped',
        metadata: { tickOverlap: true },
      };
    }
    inFlight = true;
    try {
      return await runCycle(deps);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'training-proposer tick threw',
      );
      return {
        kind: 'feature-disabled',
        message: err instanceof Error ? err.message : String(err),
        metadata: { threw: true },
      };
    } finally {
      inFlight = false;
    }
  }

  return {
    isRunning: () => started,
    start: () => {
      if (started) return;
      started = true;
      initialTimer = setTimeout(() => {
        void tick();
        timer = setInterval(() => void tick(), intervalMs);
        if (typeof timer === 'object' && 'unref' in timer) {
          timer.unref();
        }
      }, initialDelayMs);
      if (typeof initialTimer === 'object' && 'unref' in initialTimer) {
        initialTimer.unref();
      }
    },
    stop: async () => {
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      started = false;
    },
    runOnce: tick,
  };
}
