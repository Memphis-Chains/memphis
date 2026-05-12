/**
 * Self-coding plan store — durable JSON storage for multi-turn feature work.
 *
 * S5 sprint A.5.1: gives Memphis a place to keep a feature plan across
 * turns so the next turn doesn't restart from the operator's last
 * message. Tools that read/write through this store land in A.5.2.
 *
 * Storage shape mirrors tier3-session-persistence: `~/.memphis/state/`
 * with chmod 0600, atomic tmp+rename writes, fsync before rename.
 * Symlink defense + O_EXCL on the tmp prevent same-uid TOCTOU.
 *
 * Feature gate: `MEMPHIS_SELF_CODING_PLANS=0` disables persistence
 * (create/load/etc. become no-ops, and `loadAllPlans` returns []).
 * Default: enabled. This mirrors the tier3 persist gate shape so
 * operators have one consistent off-switch idiom for self-modifying
 * state files.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  PlanAdvanceInput,
  PlanCreateInput,
  PlanStatus,
  PlanStepStatus,
  SelfCodingPlan,
  SelfCodingPlanStep,
} from './plan-types.js';

const FILE_NAME = 'self-coding-plans.json';
const STATE_DIR_NAME = 'state';

const VALID_STEP_STATUSES: readonly PlanStepStatus[] = [
  'pending',
  'in_progress',
  'done',
  'failed',
  'skipped',
];

const VALID_PLAN_STATUSES: readonly PlanStatus[] = [
  'planning',
  'executing',
  'reviewing',
  'pr-open',
  'done',
  'cancelled',
];

const TERMINAL_PLAN_STATUSES: ReadonlySet<PlanStatus> = new Set([
  'done',
  'cancelled',
]);

/**
 * Plans older than this without any update get garbage-collected at load
 * time. A "stuck" plan (operator abandoned it, daemon died mid-feature)
 * eventually rots out instead of accumulating forever in the JSON file.
 * Mirrors the tier3 TTL philosophy: persisted state without explicit
 * close has a bound, not "until disk fills up".
 */
const PLAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function getPersistencePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const home = rawEnv.MEMPHIS_HOME ?? path.join(rawEnv.HOME ?? '/tmp', '.memphis');
  return path.join(home, STATE_DIR_NAME, FILE_NAME);
}

function isFeatureEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (rawEnv.MEMPHIS_SELF_CODING_PLANS ?? '1').trim();
  return flag !== '0' && flag.toLowerCase() !== 'false';
}

function nowIso(): string {
  return new Date().toISOString();
}

function generatePlanId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(4).toString('hex');
  return `plan-${yyyy}-${mm}-${dd}-${suffix}`;
}

function validateStep(raw: unknown): SelfCodingPlanStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.idx !== 'number' || !Number.isInteger(obj.idx) || obj.idx < 0) return null;
  if (typeof obj.description !== 'string' || obj.description.length === 0) return null;
  if (typeof obj.status !== 'string' || !VALID_STEP_STATUSES.includes(obj.status as PlanStepStatus)) {
    return null;
  }
  if (typeof obj.attempts !== 'number' || !Number.isInteger(obj.attempts) || obj.attempts < 0) {
    return null;
  }
  const step: SelfCodingPlanStep = {
    idx: obj.idx,
    description: obj.description,
    status: obj.status as PlanStepStatus,
    attempts: obj.attempts,
  };
  if (typeof obj.artifact === 'string' && obj.artifact.length > 0) step.artifact = obj.artifact;
  if (typeof obj.lastError === 'string' && obj.lastError.length > 0) step.lastError = obj.lastError;
  return step;
}

function validatePlan(raw: unknown): SelfCodingPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  if (typeof obj.goal !== 'string' || obj.goal.length === 0) return null;
  if (typeof obj.status !== 'string' || !VALID_PLAN_STATUSES.includes(obj.status as PlanStatus)) {
    return null;
  }
  if (obj.createdBy !== 'memphis' && obj.createdBy !== 'operator') return null;
  if (typeof obj.createdAt !== 'string' || obj.createdAt.length === 0) return null;
  if (typeof obj.updatedAt !== 'string' || obj.updatedAt.length === 0) return null;
  if (!Array.isArray(obj.steps)) return null;
  const steps: SelfCodingPlanStep[] = [];
  for (const rawStep of obj.steps) {
    const step = validateStep(rawStep);
    if (!step) return null;
    steps.push(step);
  }
  // Step idx values must form a 0..N-1 dense sequence in order — the
  // tools rely on `step_idx` matching array position so plan_advance
  // can be O(1). A sparse or shuffled set would silently break the
  // contract; reject rather than fixing-up on read.
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].idx !== i) return null;
  }
  const plan: SelfCodingPlan = {
    id: obj.id,
    goal: obj.goal,
    steps,
    status: obj.status as PlanStatus,
    createdBy: obj.createdBy,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
  };
  if (typeof obj.branch === 'string' && obj.branch.length > 0) plan.branch = obj.branch;
  if (typeof obj.prUrl === 'string' && obj.prUrl.length > 0) plan.prUrl = obj.prUrl;
  return plan;
}

function loadRaw(rawEnv: NodeJS.ProcessEnv): SelfCodingPlan[] {
  const filePath = getPersistencePath(rawEnv);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    // Fixed message — don't echo filePath (would leak MEMPHIS_HOME into
    // any log forwarder); operator can grep the prefix.
    console.warn('[self-coding-plans] state file has unexpected shape — ignoring');
    return [];
  }
  const out: SelfCodingPlan[] = [];
  const now = Date.now();
  for (const entry of parsed) {
    const plan = validatePlan(entry);
    if (!plan) continue;
    // GC rule: terminal-status plans older than PLAN_MAX_AGE_MS drop
    // off. Active plans (planning/executing/reviewing/pr-open) survive
    // indefinitely — we never want to silently abandon an in-progress
    // feature.
    if (TERMINAL_PLAN_STATUSES.has(plan.status)) {
      const updated = Date.parse(plan.updatedAt);
      if (Number.isFinite(updated) && now - updated > PLAN_MAX_AGE_MS) continue;
    }
    out.push(plan);
  }
  return out;
}

function persistRaw(plans: SelfCodingPlan[], rawEnv: NodeJS.ProcessEnv): void {
  const filePath = getPersistencePath(rawEnv);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = filePath + '.tmp';
  // Symlink defense — remove any pre-planted tmp file/symlink before
  // O_EXCL open so a same-uid attacker can't redirect our write.
  try {
    fs.unlinkSync(tmpPath);
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code;
    if (errno !== 'ENOENT') throw e;
  }
  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeSync(fd, JSON.stringify(plans, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Read all persisted plans. Returns [] on any I/O or parse failure —
 * a bad state file never blocks the daemon. Errors are logged so
 * operator can investigate; consumers see "no plans" and the runtime
 * stays up.
 */
export function loadAllPlans(rawEnv: NodeJS.ProcessEnv = process.env): SelfCodingPlan[] {
  if (!isFeatureEnabled(rawEnv)) return [];
  try {
    return loadRaw(rawEnv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[self-coding-plans] load failed: ${msg} — starting empty`);
    return [];
  }
}

export function getPlan(
  planId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SelfCodingPlan | null {
  if (!isFeatureEnabled(rawEnv)) return null;
  const plans = loadAllPlans(rawEnv);
  return plans.find((p) => p.id === planId) ?? null;
}

function persistOrWarn(plans: SelfCodingPlan[], rawEnv: NodeJS.ProcessEnv): void {
  try {
    persistRaw(plans, rawEnv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[self-coding-plans] save failed: ${msg} — in-memory caller state intact`);
  }
}

export interface CreatePlanResult {
  plan: SelfCodingPlan;
  persisted: boolean;
}

export function createPlan(
  input: PlanCreateInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): CreatePlanResult {
  if (!input.goal || input.goal.trim().length === 0) {
    throw new Error('plan.goal is required');
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new Error('plan.steps must be a non-empty array');
  }
  const steps: SelfCodingPlanStep[] = input.steps.map((s, i) => {
    if (!s || typeof s.description !== 'string' || s.description.trim().length === 0) {
      throw new Error(`plan.steps[${i}].description is required`);
    }
    return {
      idx: i,
      description: s.description.trim(),
      status: 'pending',
      attempts: 0,
    };
  });
  const ts = nowIso();
  const plan: SelfCodingPlan = {
    id: generatePlanId(),
    goal: input.goal.trim(),
    steps,
    status: 'planning',
    createdBy: input.createdBy ?? 'memphis',
    createdAt: ts,
    updatedAt: ts,
  };
  if (!isFeatureEnabled(rawEnv)) {
    return { plan, persisted: false };
  }
  const plans = loadAllPlans(rawEnv);
  plans.push(plan);
  persistOrWarn(plans, rawEnv);
  return { plan, persisted: true };
}

/**
 * Update one step of an existing plan. Returns the updated plan or
 * `null` if the plan doesn't exist / the step idx is out of range /
 * the persistence feature is disabled.
 *
 * Side effects:
 * - `attempts` is incremented when the new status is `in_progress` or
 *   `failed` (those are the "we tried" transitions). `done` and
 *   `skipped` do NOT bump attempts (avoid double-counting a success
 *   on retry).
 * - `artifact` and `lastError` are merged: setting `artifact` clears
 *   `lastError` (success cleans the failure record); setting `error`
 *   without `artifact` preserves any previous artifact (a step that
 *   succeeded once then failed on retry keeps its earlier output).
 * - Plan-level `status` auto-flips:
 *   - any step in_progress → plan 'executing'
 *   - all steps done | skipped → plan stays in current pre-terminal
 *     status (caller drives 'reviewing' / 'pr-open' / 'done'
 *     transitions explicitly via the higher-level tools).
 */
export function advanceStep(
  input: PlanAdvanceInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SelfCodingPlan | null {
  if (!isFeatureEnabled(rawEnv)) return null;
  if (!VALID_STEP_STATUSES.includes(input.status)) {
    throw new Error(`invalid step status: ${input.status}`);
  }
  const plans = loadAllPlans(rawEnv);
  const idx = plans.findIndex((p) => p.id === input.planId);
  if (idx === -1) return null;
  const plan = plans[idx];
  if (input.stepIdx < 0 || input.stepIdx >= plan.steps.length) return null;
  const step = plan.steps[input.stepIdx];
  if (input.status === 'in_progress' || input.status === 'failed') {
    step.attempts += 1;
  }
  step.status = input.status;
  if (input.artifact !== undefined) {
    step.artifact = input.artifact;
    delete step.lastError;
  }
  if (input.error !== undefined) {
    step.lastError = input.error;
  }
  if (input.status === 'in_progress' && plan.status === 'planning') {
    plan.status = 'executing';
  }
  plan.updatedAt = nowIso();
  persistOrWarn(plans, rawEnv);
  return plan;
}

export interface SetPlanStatusInput {
  planId: string;
  status: PlanStatus;
  branch?: string;
  prUrl?: string;
}

export function setPlanStatus(
  input: SetPlanStatusInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SelfCodingPlan | null {
  if (!isFeatureEnabled(rawEnv)) return null;
  if (!VALID_PLAN_STATUSES.includes(input.status)) {
    throw new Error(`invalid plan status: ${input.status}`);
  }
  const plans = loadAllPlans(rawEnv);
  const idx = plans.findIndex((p) => p.id === input.planId);
  if (idx === -1) return null;
  const plan = plans[idx];
  plan.status = input.status;
  if (input.branch !== undefined) plan.branch = input.branch;
  if (input.prUrl !== undefined) plan.prUrl = input.prUrl;
  plan.updatedAt = nowIso();
  persistOrWarn(plans, rawEnv);
  return plan;
}

export function cancelPlan(
  planId: string,
  reason: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SelfCodingPlan | null {
  if (!isFeatureEnabled(rawEnv)) return null;
  const plans = loadAllPlans(rawEnv);
  const idx = plans.findIndex((p) => p.id === planId);
  if (idx === -1) return null;
  const plan = plans[idx];
  plan.status = 'cancelled';
  plan.updatedAt = nowIso();
  // Record cancel reason on the FIRST non-terminal step's lastError
  // — cheaper than introducing a plan-level reason field, and the
  // operator-facing report already walks steps for context.
  const nonTerminalStep = plan.steps.find(
    (s) => s.status !== 'done' && s.status !== 'skipped',
  );
  if (nonTerminalStep) {
    nonTerminalStep.lastError = `plan cancelled: ${reason}`;
  }
  persistOrWarn(plans, rawEnv);
  return plan;
}

export function nextPendingStep(plan: SelfCodingPlan): SelfCodingPlanStep | null {
  return plan.steps.find((s) => s.status === 'pending' || s.status === 'failed') ?? null;
}

/**
 * Wipe the persistence file. Used by tests; never wired to a runtime
 * command path (operators clean state via vault rotation, not this).
 */
export function clearAllPlans(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const filePath = getPersistencePath(rawEnv);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[self-coding-plans] clear failed: ${msg}`);
  }
}
