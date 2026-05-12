/* eslint-disable no-restricted-syntax */
//
// memphis_self_modify — reads VITEST + MEMPHIS_DISABLE_RESTART_AFTER_EVOLVE
// + MEMPHIS_RESTART_AFTER_EVOLVE for restart-after-evolve gating logic.
// Test/local-only knobs; not used elsewhere in the codebase.
//
/**
 * memphis_self_modify — Safe self-modification MCP tool (Phase C).
 *
 * Orchestrates: session → snapshot → branch → apply changes → test gate → commit/rollback.
 * Requires git — self-modification without version control is not allowed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { realpathOrNearest } from './fs-permission.js';
import { RollbackManager } from '../../backup/rollback.js';
import { NODE_ENV } from '../../config/env-registry.js';
import {
  commitAll,
  createBranch,
  deleteBranch,
  getCurrentBranch,
  isGitRepo,
  mergeBranch,
  switchBranch,
} from '../../infra/git-utils.js';
import { createPinoLogger } from '../../infra/logging/pino.js';
import { CaseChainAdapter } from '../../infra/storage/case-chain-adapter.js';
import { SqliteEvolveSessionRepository } from '../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runTestGate, type TestGateResult } from '../../infra/test-gate.js';
import { advanceStep, getPlan } from '../../modules/self-coding/plan-store.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';
import { readTier2PassphraseFromFile } from '../../security/tier2-passphrase-file.js';
import { ensureSoulManifest, loadSoulManifest } from '../../soul/manifest.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SelfModifyInput {
  intent: string;
  files: string[];
  changes: Record<string, string>;
  passphrase?: string;
  /**
   * S5 A.5.3 step-aware mode. When `plan_id` + `step_idx` are set, the
   * tool also updates the named plan step (marks in_progress before
   * executing, done on commit, failed on rollback). The step must be
   * `pending` or `failed` (retry) — completed or in-flight steps
   * reject. Per-step idempotency: a `done` step won't re-execute.
   *
   * When fields are absent, behavior is unchanged from the original
   * one-shot self_modify (backward-compatible by design — existing
   * callers and tests pass through untouched).
   */
  plan_id?: string;
  step_idx?: number;
}

export interface SelfModifyResult {
  success: boolean;
  sessionId: string;
  status: 'committed' | 'rolled-back' | 'error';
  commitHash?: string;
  branch?: string;
  rollbackReason?: string;
  testGate?: TestGateResult;
  timestamp: string;
  /** Set when the process will restart to load new code. */
  restartScheduled?: boolean;
  /** Set when the call was step-aware (plan_id+step_idx provided). */
  plan_id?: string;
  step_idx?: number;
  /** Reason a step-aware call refused to execute (e.g. "step already done"). */
  step_skip_reason?: string;
}

export interface SelfModifyDeps {
  sessionRepo: SqliteEvolveSessionRepository;
  rollback: RollbackManager;
  caseAdapter: CaseChainAdapter;
  projectRoot?: string;
  // S5-4: thread per-request env so MEMPHIS_AUTONOMY_MODE overrides
  // reach the manifest read (mirrors tool-executor.ts pattern).
  rawEnv?: NodeJS.ProcessEnv;
}

// ── Path validation ──────────────────────────────────────────────────────────

const FORBIDDEN_SEGMENTS = ['.env', 'vault/', '.git/', 'node_modules/'];

export function validateFilePath(filePath: string, projectRoot: string): string {
  // Realpath both sides so a symlink inside the project root pointing at an
  // outside file cannot slip past the prefix check (#136). projectRoot
  // itself may be a symlink (common on NixOS / containers); realpathOrNearest
  // handles targets that don't yet exist (create-new case).
  const realRoot = realpathOrNearest(projectRoot);
  const realResolved = realpathOrNearest(resolve(projectRoot, filePath));

  if (!realResolved.startsWith(realRoot + '/') && realResolved !== realRoot) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }
  const relative = realResolved.slice(realRoot.length + 1);
  if (relative.startsWith('.')) {
    throw new Error(`Dotfile modification blocked: ${filePath}`);
  }
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (relative.includes(seg)) {
      throw new Error(`Forbidden path segment '${seg}' in: ${filePath}`);
    }
  }
  return realResolved;
}

function errorResult(reason: string): SelfModifyResult {
  return {
    success: false,
    sessionId: '',
    status: 'error',
    rollbackReason: reason,
    timestamp: new Date().toISOString(),
  };
}

// ── Step-aware helpers (S5 A.5.3) ────────────────────────────────────────────

/**
 * Validate that a step-aware self_modify call references a real plan
 * step in a runnable state. Returns null when ok; otherwise returns an
 * error reason that the caller surfaces as `step_skip_reason`.
 */
function preflightPlanStep(
  planId: string,
  stepIdx: number,
  rawEnv: NodeJS.ProcessEnv | undefined,
): { ok: true } | { ok: false; reason: string } {
  const plan = getPlan(planId, rawEnv);
  if (!plan) return { ok: false, reason: `plan not found: ${planId}` };
  if (stepIdx < 0 || stepIdx >= plan.steps.length) {
    return { ok: false, reason: `step idx out of range: ${stepIdx}` };
  }
  const step = plan.steps[stepIdx];
  // Idempotency: a `done` step is a no-op. `in_progress` blocks a
  // concurrent caller. `skipped` shouldn't be re-tried via self_modify
  // — operator marks it skipped intentionally.
  if (step.status === 'done') {
    return { ok: false, reason: `step already done: ${planId}#${stepIdx}` };
  }
  if (step.status === 'in_progress') {
    return { ok: false, reason: `step already in_progress: ${planId}#${stepIdx}` };
  }
  if (step.status === 'skipped') {
    return { ok: false, reason: `step is skipped: ${planId}#${stepIdx}` };
  }
  return { ok: true };
}

/**
 * Wrap `errorResult` with step-aware plumbing: marks the named plan
 * step `failed` (so a stuck in_progress doesn't linger after a
 * preflight failure) and stamps the result with plan_id/step_idx.
 * No-op for non-step calls.
 */
function planAwareErrorResult(
  reason: string,
  planId: string | undefined,
  stepIdx: number | undefined,
  rawEnv: NodeJS.ProcessEnv | undefined,
): SelfModifyResult {
  const base = errorResult(reason);
  if (typeof planId !== 'string' || typeof stepIdx !== 'number') return base;
  advanceStep(
    { planId, stepIdx, status: 'failed', error: reason },
    rawEnv,
  );
  return { ...base, plan_id: planId, step_idx: stepIdx };
}

async function appendRollbackAudit(caseAdapter: CaseChainAdapter, reason: string): Promise<void> {
  try {
    await caseAdapter.appendCaseEntry({
      case_type: 'accusative',
      subject: 'agent',
      verb: 'rolled-back',
      object: `evolution failed: ${reason.slice(0, 200)}`,
    });
  } catch {
    // audit is best-effort
  }
}

async function finalizeFailedEvolution(input: {
  sessionId: string;
  reason: string;
  sessionRepo: SqliteEvolveSessionRepository;
  rollback: RollbackManager;
  caseAdapter: CaseChainAdapter;
  projectRoot: string;
  originalBranch?: string;
  evolveBranch?: string;
  snapshotId?: string;
  auditAction: string;
  auditStatus: 'blocked' | 'error';
  testGate?: TestGateResult;
}): Promise<SelfModifyResult> {
  const {
    sessionId,
    reason,
    sessionRepo,
    rollback,
    caseAdapter,
    projectRoot,
    originalBranch,
    evolveBranch,
    snapshotId,
    auditAction,
    auditStatus,
    testGate,
  } = input;

  let switchedBranch = false;
  let deletedBranch = false;
  let restoredSnapshot = false;

  if (originalBranch) {
    try {
      await switchBranch(originalBranch, projectRoot);
      switchedBranch = true;
    } catch {
      // best-effort branch cleanup
    }
  }

  if (evolveBranch) {
    try {
      await deleteBranch(evolveBranch, projectRoot);
      deletedBranch = true;
    } catch {
      // best-effort branch cleanup
    }
  }

  if (snapshotId) {
    try {
      const rollbackResult = await rollback.rollback(snapshotId);
      restoredSnapshot = rollbackResult.success;
    } catch {
      // best-effort snapshot rollback
    }
  }

  sessionRepo.updateStatus(sessionId, 'rolled-back', {
    errorMessage: reason,
  });

  await emitRuntimeSecurityEvent({
    action: auditAction,
    status: auditStatus,
    details: {
      sessionId,
      reason,
      originalBranch,
      evolveBranch,
      snapshotId,
      switchedBranch,
      deletedBranch,
      restoredSnapshot,
    },
  });

  await appendRollbackAudit(caseAdapter, reason);

  return {
    success: false,
    sessionId,
    status: 'rolled-back',
    rollbackReason: reason,
    testGate,
    timestamp: new Date().toISOString(),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runMemphisSelfModify(
  input: SelfModifyInput,
  deps: SelfModifyDeps,
): Promise<SelfModifyResult> {
  const { intent, files, changes, plan_id: planId, step_idx: stepIdx } = input;
  const { sessionRepo, rollback, caseAdapter } = deps;
  const projectRoot = deps.projectRoot ?? process.cwd();
  const planAware = typeof planId === 'string' && typeof stepIdx === 'number';

  // 0a. Step-aware preflight — refuse early if the plan step is in a
  // bad state. We do this before any side effects so a no-op step
  // call never creates an evolve session, never branches, never runs
  // tests.
  if (planAware) {
    const guard = preflightPlanStep(planId, stepIdx, deps.rawEnv);
    if (!guard.ok) {
      return {
        success: false,
        sessionId: '',
        status: 'error',
        rollbackReason: guard.reason,
        plan_id: planId,
        step_idx: stepIdx,
        step_skip_reason: guard.reason,
        timestamp: new Date().toISOString(),
      };
    }
    // Mark step in_progress upfront so a concurrent step-aware call
    // for the same (planId, stepIdx) immediately fails the preflight
    // above. attempts bumps by 1 here.
    advanceStep(
      { planId, stepIdx, status: 'in_progress' },
      deps.rawEnv,
    );
  }

  // 0. Validate inputs
  if (files.length === 0 || Object.keys(changes).length === 0) {
    return planAwareErrorResult(
      'No files or changes provided',
      planId,
      stepIdx,
      deps.rawEnv,
    );
  }

  // Validate all file paths before doing anything
  for (const f of files) {
    validateFilePath(f, projectRoot);
  }
  for (const f of Object.keys(changes)) {
    validateFilePath(f, projectRoot);
  }

  // Require git — self-modification without version control is not allowed
  if (!(await isGitRepo(projectRoot))) {
    return planAwareErrorResult(
      'Self-modification requires a git repository for safe rollback',
      planId,
      stepIdx,
      deps.rawEnv,
    );
  }

  // Enforce evolution policy
  ensureSoulManifest(deps.rawEnv);

  // Passphrase gate for tier 2 self-modification (skipped in full autonomy mode)
  const manifest = loadSoulManifest(deps.rawEnv);
  if (manifest?.evolution?.requirePassphraseForTier2 && manifest.mode !== 'full') {
    if (!manifest.evolution.passphraseHash) {
      return planAwareErrorResult(
        'Passphrase gate enabled but no passphraseHash configured in soul manifest. ' +
          'Set evolution.passphraseHash via memphis trust set-passphrase or memphis init.',
        planId,
        stepIdx,
        deps.rawEnv,
      );
    }

    // Use provided passphrase, or try to read from file
    let passphrase = input.passphrase;
    if (!passphrase) {
      passphrase = readTier2PassphraseFromFile() ?? undefined;
      if (passphrase) {
        console.log('[tier2] Auto-obtained passphrase from secure file');
      }
    }

    if (!passphrase) {
      return planAwareErrorResult(
        'Passphrase required for self-modification (tier 2). Provide a passphrase or ensure ~/.memphis/.tier2-passphrase exists.',
        planId,
        stepIdx,
        deps.rawEnv,
      );
    }
    const inputHash = createHash('sha256').update(passphrase).digest('hex');
    if (inputHash !== manifest.evolution.passphraseHash) {
      return planAwareErrorResult(
        'Passphrase rejected — hash mismatch.',
        planId,
        stepIdx,
        deps.rawEnv,
      );
    }
  }

  // 1. Create session
  const session = sessionRepo.create({ intent, filesAllowed: files });
  sessionRepo.updateStatus(session.id, 'approved');

  let originalBranch = '';
  let evolveBranch = '';
  let snapshotId: string | undefined;

  try {
    // 2. Snapshot
    snapshotId = await rollback.createSnapshot(`evolve: ${intent}`);

    // 3. Branch isolation
    originalBranch = await getCurrentBranch(projectRoot);
    const slug = intent
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    evolveBranch = `evolve/${Date.now()}-${slug}`;
    await createBranch(evolveBranch, projectRoot);

    sessionRepo.updateStatus(session.id, 'active', {
      snapshotId,
      branch: evolveBranch,
      originalBranch,
    });

    // 4. Apply changes
    for (const [filePath, content] of Object.entries(changes)) {
      if (!files.includes(filePath)) {
        throw new Error(`File ${filePath} not in allowed list: ${files.join(', ')}`);
      }
      const scan = scanContent(content, 'code-change');
      if (!scan.allowed) {
        const scanReason = `Blocked self-modify content for ${filePath}: ${scan.reason}`;
        if (planAware) {
          advanceStep(
            { planId, stepIdx, status: 'failed', error: scanReason },
            deps.rawEnv,
          );
        }
        const blockedResult = await finalizeFailedEvolution({
          sessionId: session.id,
          reason: scanReason,
          sessionRepo,
          rollback,
          caseAdapter,
          projectRoot,
          originalBranch,
          evolveBranch,
          snapshotId,
          auditAction: 'content_scan.self_modify.blocked',
          auditStatus: 'blocked',
        });
        return planAware
          ? { ...blockedResult, plan_id: planId, step_idx: stepIdx }
          : blockedResult;
      }
      const fullPath = validateFilePath(filePath, projectRoot);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }

    // 5. Test gate (pass changed files so it knows whether to rebuild Rust)
    const changedFiles = Object.keys(changes);
    const testResult = await runTestGate(projectRoot, changedFiles);

    if (testResult.passed) {
      // 6a. Commit + merge
      const commitHash = await commitAll(`evolve: ${intent}`, projectRoot, files);
      // Phase 2.3 production sprint: record the previous-known-good
      // hash BEFORE the merge so a boot-failure auto-revert can roll
      // back if the merged code breaks startup.
      const previousHash = await (async () => {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          const { stdout } = await execFileAsync('git', ['rev-parse', originalBranch], {
            cwd: projectRoot,
          });
          return stdout.trim();
        } catch {
          return '';
        }
      })();
      await switchBranch(originalBranch, projectRoot);
      await mergeBranch(evolveBranch, projectRoot);
      await deleteBranch(evolveBranch, projectRoot);
      if (previousHash) {
        try {
          const { recordSelfModifyCommit } =
            await import('../../infra/runtime/self-modify-revert.js');
          recordSelfModifyCommit({
            commitHash,
            previousHash,
            intent,
          });
        } catch {
          // best-effort
        }
      }

      sessionRepo.updateStatus(session.id, 'committed', { committedHash: commitHash });
      await emitRuntimeSecurityEvent({
        action: 'self_modify.committed',
        status: 'allowed',
        details: {
          sessionId: session.id,
          commitHash,
          changedFiles,
          snapshotId,
          branch: evolveBranch,
          originalBranch,
        },
      });

      try {
        await caseAdapter.appendCaseEntry({
          case_type: 'accusative',
          subject: 'agent',
          verb: 'evolved',
          object: `modified ${changedFiles.length} file(s): ${intent} [${commitHash.slice(0, 8)}]`,
        });
      } catch {
        // audit is best-effort
      }

      // Schedule graceful restart if MEMPHIS_RESTART_AFTER_EVOLVE is set.
      // systemd will restart the process on exit. Never fire under vitest — a
      // stray process.exit() from a pending timer kills the test runner.
      const inTestRunner =
        process.env.VITEST === 'true' ||
        NODE_ENV.read(process.env) === 'test' ||
        process.env.MEMPHIS_DISABLE_RESTART_AFTER_EVOLVE === 'true';
      const shouldRestart =
        !inTestRunner &&
        (process.env.MEMPHIS_RESTART_AFTER_EVOLVE ?? 'true').toLowerCase() === 'true';
      if (shouldRestart) {
        const selfModifyLog = createPinoLogger({ level: 'info' });
        selfModifyLog.info(
          { commitHash, changedFiles, intent },
          'self-modify committed — scheduling graceful restart in 2s to reload code',
        );
        setTimeout(() => {
          // Exit with code 0 — systemd/wrapper will restart
          // The PULSE system will log the restart on next boot
          process.exit(0);
        }, 2000);
      }

      if (planAware) {
        advanceStep(
          { planId, stepIdx, status: 'done', artifact: commitHash },
          deps.rawEnv,
        );
      }

      return {
        success: true,
        sessionId: session.id,
        status: 'committed',
        commitHash,
        testGate: testResult,
        timestamp: new Date().toISOString(),
        restartScheduled: shouldRestart,
        ...(planAware ? { plan_id: planId, step_idx: stepIdx } : {}),
      };
    }

    // 6b. Test failed — rollback
    const failedStep = testResult.steps.find((s) => !s.passed);
    const reason = `test gate failed at ${failedStep?.name ?? 'unknown'}: ${failedStep?.output.slice(-200) ?? ''}`;
    if (planAware) {
      advanceStep(
        { planId, stepIdx, status: 'failed', error: reason },
        deps.rawEnv,
      );
    }
    const failResult = await finalizeFailedEvolution({
      sessionId: session.id,
      reason,
      sessionRepo,
      rollback,
      caseAdapter,
      projectRoot,
      originalBranch,
      evolveBranch,
      snapshotId,
      auditAction: 'self_modify.test_gate.failed',
      auditStatus: 'blocked',
      testGate: testResult,
    });
    return planAware ? { ...failResult, plan_id: planId, step_idx: stepIdx } : failResult;
  } catch (err) {
    // Catastrophic failure — rollback everything
    const errorMsg = err instanceof Error ? err.message : String(err);
    const currentSnapshotId = sessionRepo.getById(session.id)?.snapshotId ?? snapshotId;
    if (planAware) {
      advanceStep(
        { planId, stepIdx, status: 'failed', error: `exception: ${errorMsg}` },
        deps.rawEnv,
      );
    }
    const exResult = await finalizeFailedEvolution({
      sessionId: session.id,
      reason: `exception: ${errorMsg}`,
      sessionRepo,
      rollback,
      caseAdapter,
      projectRoot,
      originalBranch,
      evolveBranch,
      snapshotId: currentSnapshotId ?? undefined,
      auditAction: 'self_modify.exception',
      auditStatus: 'error',
    });
    return planAware ? { ...exResult, plan_id: planId, step_idx: stepIdx } : exResult;
  }
}
