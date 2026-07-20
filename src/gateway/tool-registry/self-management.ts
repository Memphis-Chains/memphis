import { z } from 'zod';

import type { ToolMeta } from '../tool-metadata.js';

export const SELF_MANAGEMENT_TOOLS: Record<string, ToolMeta> = {
  memphis_self_plan_create: {
    name: 'memphis_self_plan_create',
    tier: 0,
    capabilities: ['write'],
    description: 'Create a multi-step self-coding plan (durable across turns)',
    inputSchema: z
      .object({
        goal: z.string().min(1),
        steps: z.array(z.object({ description: z.string().min(1) }).strict()).min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Open a durable plan for a multi-file feature. Provide `goal` (operator-facing one-liner) and `steps` (array of {description}). Each step becomes a unit of work Memphis advances through with `memphis_self_plan_advance`. Plan is persisted to `~/.memphis/state/self-coding-plans.json` so the next turn picks up where the last one left off. Returns the `plan_id` (e.g. `plan-2026-05-12-a4f2`) used by all other plan tools. Tier-0 (data-only); the underlying `memphis_self_modify` calls per step remain tier-2.',
  },
  memphis_self_plan_get: {
    name: 'memphis_self_plan_get',
    tier: 0,
    capabilities: ['read'],
    description: 'Read a self-coding plan by id (returns next pending step too)',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Fetch the current state of a plan. Returns `{plan, next_step}` where `next_step` is the first step with status `pending` or `failed` (failed steps come first so a retry resumes before new work). Call at turn start when continuing a plan: tells you which step to attempt without scanning the history. Returns `{ok:false, error}` if the plan id is unknown.',
  },
  memphis_self_plan_advance: {
    name: 'memphis_self_plan_advance',
    tier: 0,
    capabilities: ['write'],
    description: 'Mark a plan step as done/failed/in_progress/skipped',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        step_idx: z.number().int().nonnegative(),
        status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
        artifact: z.string().optional(),
        error: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Record progress on one step. `status`: pending→in_progress when starting work; in_progress→done on success (pass `artifact` — file path / PR url / sha); in_progress→failed on test red (pass `error` — terse failure message). `attempts` auto-increments on in_progress/failed (so retry counts are tracked). Plan-level status auto-flips planning→executing on first in_progress. Per-step idempotent — same `(plan_id, step_idx)` twice produces the same shape.',
  },
  memphis_self_plan_cancel: {
    name: 'memphis_self_plan_cancel',
    tier: 0,
    capabilities: ['write'],
    description: 'Cancel a self-coding plan with a reason recorded for audit',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        reason: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "End-of-line a plan. Sets status to `cancelled` and records the reason on the first non-terminal step's `lastError` (so operator-side report still has context). Use when scope changed mid-feature, operator redirected, or the plan turned out infeasible.",
  },
  memphis_self_review: {
    name: 'memphis_self_review',
    tier: 0,
    capabilities: ['read'],
    description: 'Pre-PR review of a self-coding plan: gap/scope-creep/TODO check',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      "Run before `memphis_self_pr_open` to catch plan drift. Reports four classes of issue: (1) steps marked `done` with no artifact recorded (plan-store corruption); (2) non-terminal steps left over (unfinished work); (3) files in the plan's diff that no step description names (scope creep); (4) added TODO/FIXME/XXX/HACK markers (technical debt). Returns `{ok, checklist, blockers[]}`. Per-step lint+typecheck are NOT re-run — those already ran inside `memphis_self_modify`'s test gate at commit time.",
  },
  memphis_self_pr_open: {
    name: 'memphis_self_pr_open',
    tier: 2,
    capabilities: ['execute', 'network'],
    description: 'Push the plan branch and open a PR via gh (operator must merge)',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        title: z.string().optional(),
        body_prefix: z.string().optional(),
        branch: z.string().optional(),
        base: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Close a plan by pushing its branch and opening a PR. Required: every step is `done` or `skipped` (preflight rejects unfinished plans). Auto-derives PR title from `plan.goal` and body from the step list (status markers + artifact + retry counts). Sets plan status to `pr-open` + records the returned PR url. Tier-2 because this opens a real PR visible to teammates; the operator passphrase gate at the policy layer enforces explicit approval. **Memphis NEVER merges its own PR** — only operator does, by design. Refuses to push from `main`/`master`/the configured base.',
  },
  memphis_self_deploy_verify: {
    name: 'memphis_self_deploy_verify',
    tier: 0,
    capabilities: ['read', 'execute'],
    description: 'C-step: confirm the merged PR is on origin/main and the build is fresh',
    inputSchema: z
      .object({
        plan_id: z.string().min(1),
        build_artifact_path: z.string().optional(),
        base: z.string().optional(),
        approval_request_id: z.string().optional(),
      })
      .strict(),
    helpText:
      'Verify a plan actually shipped. After operator merges the PR from `memphis_self_pr_open`, call this to confirm: (1) PR is merged via gh, (2) merge commit is an ancestor of origin/main (local fetch happens first), (3) build artifact mtime is newer than the merge timestamp (proves a rebuild happened). On all three green, sets plan status to `done`. If anything fails, plan stays in `pr-open` and the operator-facing report names which check failed.',
  },
};
