/**
 * Internal local-operator preparer for self-modification requests.
 *
 * Creates a snapshot and tests the requested changes in an isolated Git
 * worktree. The resulting commit requires a separate operator review.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { realpathOrNearest } from './fs-permission.js';
import { runMemphisSelfGovernanceStatus } from './self-governance-status.js';
import { RollbackManager } from '../../backup/rollback.js';
import { isGitRepo } from '../../infra/git-utils.js';
import { evolveGit } from '../../infra/runtime/evolve-review.js';
import { createEvolveWorktree, commitEvolveWorktree } from '../../infra/runtime/evolve-worktree.js';
import { CaseChainAdapter } from '../../infra/storage/case-chain-adapter.js';
import { SqliteEvolveSessionRepository } from '../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runTestGate, type TestGateResult } from '../../infra/test-gate.js';
import { advanceStep, getPlan } from '../../modules/self-coding/plan-store.js';
import { scanContent } from '../../security/content-scan.js';
import { emitRuntimeSecurityEvent } from '../../security/runtime-security-events.js';
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
  status: 'prepared' | 'committed' | 'rolled-back' | 'error';
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
    caseAdapter,
    originalBranch,
    evolveBranch,
    snapshotId,
    auditAction,
    auditStatus,
    testGate,
  } = input;

  // Preparation runs in an isolated worktree: do not switch the live branch,
  // delete a branch, or restore a snapshot over unrelated operator work.

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
      worktreeRetained: Boolean(evolveBranch),
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

  // This status used to be advisory only. Refuse before plan, session,
  // snapshot, branch or file side effects if the live gate is not ready.
  try {
    const governance = await runMemphisSelfGovernanceStatus(deps.rawEnv);
    if (!governance.canSelfModify) {
      return errorResult(`Self-modification blocked by governance: ${governance.blockingReasons.join('; ') || 'readiness unavailable'}`);
    }
  } catch {
    return errorResult('Self-modification blocked: governance status unavailable');
  }

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

  // Tier 2 self-modification always needs a conscious passphrase, regardless
  // of autonomy mode. Never source it from a standalone passphrase file.
  const manifest = loadSoulManifest(deps.rawEnv);
  {
    const expected = manifest?.evolution?.passphraseHash;
    if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
      return planAwareErrorResult(
        'Passphrase gate enabled but no passphraseHash configured in soul manifest. ' +
          'Set evolution.passphraseHash via memphis trust set-passphrase or memphis init.',
        planId,
        stepIdx,
        deps.rawEnv,
      );
    }

    if (!input.passphrase) {
      return planAwareErrorResult(
        'Passphrase required for self-modification (tier 2).',
        planId,
        stepIdx,
        deps.rawEnv,
      );
    }
    const inputHash = createHash('sha256').update(input.passphrase).digest();
    if (!timingSafeEqual(inputHash, Buffer.from(expected, 'hex'))) {
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

    // 3. Prepare and test in a separate Git worktree. The live checkout is
    // neither switched nor edited by the agent.
    const workspace = await createEvolveWorktree(projectRoot, session.id, deps.rawEnv);
    originalBranch = workspace.target;
    evolveBranch = workspace.branch;
    sessionRepo.updateStatus(session.id, 'active', {
      snapshotId, branch: evolveBranch, originalBranch,
    });

    for (const [filePath, content] of Object.entries(changes)) {
      if (!files.includes(filePath)) throw new Error(`File ${filePath} is not in the allowed list`);
      const scan = scanContent(content, 'code-change');
      if (!scan.allowed) throw new Error(`Blocked self-modify content for ${filePath}: ${scan.reason}`);
      const fullPath = validateFilePath(filePath, workspace.worktree);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }
    const changedFiles = Object.keys(changes);
    const testResult = await runTestGate(workspace.worktree, changedFiles);

    if (testResult.passed) {
      // Do not allow the test command to silently replace the reviewed input.
      for (const [filePath, expected] of Object.entries(changes)) {
        const actual = readFileSync(validateFilePath(filePath, workspace.worktree), 'utf8');
        if (actual !== expected) throw new Error(`test changed proposed content: ${filePath}`);
      }
      const commitHash = await commitEvolveWorktree(workspace.worktree, changedFiles, intent, deps.rawEnv);
      const parents = (await evolveGit(workspace.worktree, ['rev-list', '--parents', '-n', '1', commitHash])).split(' ');
      const committedPaths = (await evolveGit(workspace.worktree, ['diff', '--name-only', '-z', workspace.base, commitHash])).split('\0').filter(Boolean);
      if (parents.length !== 2 || parents[1] !== workspace.base || committedPaths.length !== changedFiles.length ||
          committedPaths.some((file) => !changedFiles.includes(file)))
        throw new Error('commit does not match the reviewed base and paths');
      if (await evolveGit(workspace.worktree, ['status', '--porcelain', '--untracked-files=all']) !== '')
        throw new Error('commit hooks left the proposal worktree dirty');
      const objectFormat = await evolveGit(workspace.worktree, ['rev-parse', '--show-object-format']);
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new Error('unsupported Git object format');
      for (const [filePath, expected] of Object.entries(changes)) {
        const actual = readFileSync(validateFilePath(filePath, workspace.worktree));
        if (actual.toString('utf8') !== expected)
          throw new Error(`commit hook changed proposed content: ${filePath}`);
        const blob = createHash(objectFormat).update(`blob ${actual.length}\0`).update(actual).digest('hex');
        if (await evolveGit(workspace.worktree, ['rev-parse', `${commitHash}:${filePath}`]) !== blob)
          throw new Error(`committed content differs from tested content: ${filePath}`);
      }
      sessionRepo.finalizePrepared({ sessionId: session.id, ...workspace, commit: commitHash,
        testSummary: JSON.stringify(testResult.steps.map(({ name, passed }) => ({ name, passed }))),
        status: 'prepared', ...(planAware ? { planId, stepIdx } : {}) });
      // Once persisted, audit failures cannot make an approved candidate look
      // rolled back. The review row remains the authoritative state.
      try { await emitRuntimeSecurityEvent({ action: 'self_modify.prepared', status: 'allowed',
        details: { sessionId: session.id, commitHash, changedFiles, snapshotId,
          branch: evolveBranch, originalBranch } }); } catch { /* visible via review store */ }
      return { success: true, sessionId: session.id, status: 'prepared', commitHash,
        branch: evolveBranch, testGate: testResult, timestamp: new Date().toISOString(),
        restartScheduled: false, ...(planAware ? { plan_id: planId, step_idx: stepIdx } : {}) };
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
    // Leave the isolated worktree intact for inspection and keep the live checkout untouched.
    const errorMsg = err instanceof Error ? err.message : String(err);
    const blockedByScan = errorMsg.startsWith('Blocked self-modify content');
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
      auditAction: blockedByScan ? 'content_scan.self_modify.blocked' : 'self_modify.exception',
      auditStatus: blockedByScan ? 'blocked' : 'error',
    });
    return planAware ? { ...exResult, plan_id: planId, step_idx: stepIdx } : exResult;
  }
}
