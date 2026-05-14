# Kartograf-nightly v2 modules — implementation sketch

**Status:** SKETCH only, no commit. Ready to apply on a fresh `feat/kartograf-nightly-v2` branch AFTER Coder A's Temat 1 (vision + exec) and Temat 2 (SEGV embed_shutdown) ship + daemon restart green.

**Scope source:** plan-file `~/.claude/plans/i-co-widzisz-logical-squid.md` v2 addendum (narrow: observe + propose, NO auto-install in v2).

**Files in scope (all NEW, no existing-file modifications except Phase 8 bootstrap stopFns append):**

```
src/modules/nightly/training-worker.ts          # spawn + PID map + cancel (no install enqueue in v2)
src/modules/nightly/training-job-runner.ts      # polls scheduled_jobs, dispatch, recovery-on-restart
src/modules/nightly/training-proposer.ts        # autonomous propose-when-quiet
src/modules/nightly/types.ts                    # shared types (TrainingMode, JobPayload, etc.)
tests/unit/nightly-training-worker.test.ts
tests/unit/nightly-training-job-runner.test.ts
tests/unit/nightly-training-proposer.test.ts
```

**Files modified (minimal):**

```
src/app/bootstrap.ts                            # APPEND 2 entries to stopFns (around :527-551)
                                                # no other lines touched
```

**Reused (no modification, already on main):**

- `src/infra/storage/sqlite/repositories/scheduled-job-repository.ts` — Migration v7
- `src/infra/runtime/atomic-write.ts` — Coder B Phase 0 (already in my worktree, will commit fresh)
- `src/kartograf/rollback.ts` — Coder B Phase 1 (kept, used for backup snapshot reads; rollback not auto-invoked in v2)
- `src/core/surface-presence.ts` — operator-idle signal source
- `src/infra/runtime/reflection-loop.ts` — proposer skeleton template
- `tools/training/kartograf_train/status_writer.py` — Coder B Phase 2 (Python side; train.py wiring deferred until Coder A's Temat 4 lifts the transformers version constraint AND operator authorizes the train.py edits)

---

## Module 1: `src/modules/nightly/types.ts`

```typescript
export type TrainingMode = 'smoke' | 'full';

export interface TrainingJobPayload {
  mode: TrainingMode;
  corpus_dir: string;          // ~/.memphis/kartograf/corpus/v<N>/
  signing_seed_file: string;   // ~/.memphis/kartograf/signing-seed.bin
  out_dir: string;             // ~/.memphis/kartograf/staging/<job_id>/
  proposed_at_iso: string;
}

export interface TrainingStatusFile {
  state: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  step?: number;
  total_steps?: number;
  avg_loss?: number;
  last_loss?: number;
  gpu_mb?: number;
  started_at_ms: number;
  host_pid: number;
  // terminal-state additions:
  completed_at_ms?: number;
  failed_at_ms?: number;
  cancelled_at_ms?: number;
  error?: string;
  signal?: string;
  eval_recall_at_10?: number;
  onnx_sha256?: string;
  envelope_path?: string;
}
```

## Module 2: `src/modules/nightly/training-worker.ts`

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveInstallRoot } from '../../infra/runtime/install-root.js';
import { atomicWriteJsonSync } from '../../infra/runtime/atomic-write.js';
import type { TrainingJobPayload } from './types.js';

interface TrainingChild {
  jobId: string;
  pid: number;
  child: ChildProcess;
  startedAtMs: number;
}

const liveChildren = new Map<string, TrainingChild>();

export function getStatusFilePath(rawEnv = process.env): string {
  return `${rawEnv.MEMPHIS_HOME ?? `${rawEnv.HOME}/.memphis`}/state/kartograf-training.json`;
}

export function spawnTraining(jobId: string, payload: TrainingJobPayload, rawEnv = process.env): TrainingChild {
  const installRoot = resolveInstallRoot({ rawEnv });
  const args = [
    `${installRoot}/tools/training/train-kartograf.py`,
    '--corpus', payload.corpus_dir,
    '--out', payload.out_dir,
    '--signing-seed-file', payload.signing_seed_file,
    '--mode', payload.mode,
    // --status-file added once Coder A's Temat 4 lifts the F8 transformers constraint
    // AND operator authorizes train.py edits (Phase 2 train.py wiring was reverted earlier).
  ];
  const child = spawn(`${rawEnv.HOME}/.venvs/memphis-train/bin/python3`, args, {
    env: rawEnv, detached: false, stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.set(jobId, { jobId, pid: child.pid!, child, startedAtMs: Date.now() });
  return liveChildren.get(jobId)!;
}

export async function cancelTraining(jobId: string, killGraceMs = 30_000): Promise<boolean> {
  const live = liveChildren.get(jobId);
  if (!live) return false;
  live.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 10_000));
  if (!live.child.killed) live.child.kill('SIGINT');
  await new Promise((r) => setTimeout(r, killGraceMs - 10_000));
  if (!live.child.killed) live.child.kill('SIGKILL');
  liveChildren.delete(jobId);
  return true;
}

export function listLiveJobs(): Array<{ jobId: string; pid: number; startedAtMs: number }> {
  return [...liveChildren.values()].map(({ jobId, pid, startedAtMs }) => ({ jobId, pid, startedAtMs }));
}
```

## Module 3: `src/modules/nightly/training-job-runner.ts`

```typescript
import { SqliteScheduledJobRepository } from '../../infra/storage/sqlite/repositories/scheduled-job-repository.js';
import { spawnTraining, type TrainingChild } from './training-worker.js';
import type { TrainingJobPayload } from './types.js';

export class TrainingJobRunner {
  private timer: NodeJS.Timeout | null = null;
  constructor(
    private repo: SqliteScheduledJobRepository,
    private intervalMs = 30_000,
  ) {}

  start(): void {
    // On boot: recover any active rows from prior daemon → mark failed.
    // V2 policy per plan: do NOT auto-retry, operator decides.
    this.recoverActiveFromCrash();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop({ killChildren = true } = {}): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (killChildren) {
      // cancel all live training children
      // (implementation: walk listLiveJobs, cancelTraining each)
    }
  }

  private recoverActiveFromCrash(): void {
    const active = this.repo.listByStatus('active');
    for (const j of active) {
      if (j.type !== 'kartograf-training') continue;
      this.repo.markFailed(j.id, 'daemon-restart-during-run');
    }
  }

  private async tick(): Promise<void> {
    // One-at-a-time: refuse to dispatch second training if one is active.
    const active = this.repo.listByStatus('active').filter((j) => j.type === 'kartograf-training');
    if (active.length > 0) return;

    const due = this.repo.listDueNow().filter((j) => j.type === 'kartograf-training');
    if (due.length === 0) return;

    const job = due[0];
    const payload = JSON.parse(job.payload) as TrainingJobPayload;
    this.repo.markActive(job.id);
    const child = spawnTraining(job.id, payload);
    child.child.once('exit', (code, signal) => {
      if (code === 0) {
        this.repo.markCompleted(job.id);
        // V2 explicitly does NOT enqueue follow-up kartograf-install job.
        // Operator runs `memphis kartograf install` manually after each successful training.
      } else {
        this.repo.markFailed(job.id, signal ?? `exit ${code}`);
      }
    });
  }
}
```

## Module 4: `src/modules/nightly/training-proposer.ts`

Pattern: mirror `src/infra/runtime/reflection-loop.ts:241-327` shape exactly. Constructor opts (env interval, initial delay, `runCycle?` test seam), `start/stop/runOnce/tick`, `inFlight` guard.

`tick()` decision tree (matches plan-v2 addendum Phase 5):

1. **Feature gate:** `MEMPHIS_TRAINING_PROPOSE_ENABLED` (default `false`).
2. **Operator-quiet gate:** `getActiveSurfacesSnapshot({ staleMs: DEFAULT_STALE_MS })`. Skip unless all stale AND `max(ageMs) > MEMPHIS_TRAINING_QUIET_MS` (default 2 h).
3. **Corpus freshness:** stat `~/.memphis/kartograf/corpus/v<latest>/corpus-v1-summary.json`. Stale (>7 d) or missing → emit `corpus_proposal` insights block + Telegram ping (rate-limited 1/day via `SeenProposalRepository`). Return.
4. **Active-job gate:** if any pending/active `kartograf-training` row → skip.
5. **Cooldown:** most recent completed `kartograf-training` must be older than `MEMPHIS_TRAINING_PROPOSE_AGE_MS` (default 7 d).
6. **Enqueue:** `repo.create({ type: 'kartograf-training', payload: JSON.stringify(payload), delayMs: 0 })`. Emit `training_proposed_and_started` insights block.

## Module 5 (modify): `src/app/bootstrap.ts:527-551` stopFns APPEND

```typescript
stopFns: [
  // ... existing entries unchanged ...
  // APPEND for v2 nightly:
  { name: 'training-proposer-loop', stop: async () => trainingProposerHandle.stop() },
  { name: 'kartograf-job-runner',   stop: async () => kartografJobRunnerHandle.stop({ killChildren: true }) },
],
```

Plus 2 lines after line 518 (after `startScheduler`):

```typescript
const trainingProposerHandle = startTrainingProposerLoop({ rawEnv: process.env });
const kartografJobRunnerHandle = startKartografJobRunner({
  scheduledJobRepository: container.scheduledJobRepository,
  rawEnv: process.env,
});
```

## Verification (B-step post-implementation)

1. Set fast cadence: `MEMPHIS_TRAINING_PROPOSE_ENABLED=true`, `MEMPHIS_TRAINING_PROPOSE_INTERVAL_MS=10000`, `MEMPHIS_TRAINING_PROPOSE_AGE_MS=0`, `MEMPHIS_TRAINING_QUIET_MS=1000`.
2. Restart daemon. Wait 30 s. Verify `scheduled_jobs` has a `kartograf-training` row (`pending` or `active`).
3. Job runner spawns child python3 → status flows via stdout (status-file deferred to Coder A's Temat 4).
4. Smoke run completes (~5 min). `markCompleted`. Operator runs `memphis kartograf install --file <out_dir>/checkpoint.json --source file` manually.
5. Telegram: `/nightly status` returns the recent rows + doctor verdict for `ta14-kartograf-training-active`.
6. Cancel: `memphis nightly cancel <job_id>` → SIGTERM child → status `cancelled`.

## What's NOT in v2 (explicit defer to v3 — already in plan addendum)

- Phase 1 rollback infrastructure (backup-on-install + rollback CLI + auto-rollback hook in runtime.ts) — `src/kartograf/rollback.ts` stays in worktree as a building block
- Phase 4 install-runner with eval-gate — deferred until v3
- Phase 6 `memphis_nightly_cancel`, `memphis_nightly_force_train`, `memphis_best_practices` — v2 only exposes `memphis_nightly_status` (tier 1 read)
- `/nightly-elevate <pass>` tier-3-long — v2 needs no elevation (data-dir-local writes only)
- Auto-install flow — operator manual `memphis kartograf install` per training
