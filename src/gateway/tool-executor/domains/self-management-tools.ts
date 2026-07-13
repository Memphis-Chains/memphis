import { AppError } from '../../../core/errors.js';
import { runMemphisSelfDeployVerify } from '../../../mcp/tools/self-deploy-verify.js';
import { runMemphisSelfDescribe } from '../../../mcp/tools/self-describe.js';
import {
  runMemphisSelfPlanAdvance,
  runMemphisSelfPlanCancel,
  runMemphisSelfPlanCreate,
  runMemphisSelfPlanGet,
} from '../../../mcp/tools/self-plan.js';
import { runMemphisSelfPrOpen } from '../../../mcp/tools/self-pr-open.js';
import { runMemphisSelfReview } from '../../../mcp/tools/self-review.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalString, requiredString } from '../input-normalization.js';

export function createSelfManagementRuntimeTools(
  rawEnv?: NodeJS.ProcessEnv,
  activeSurface?: string,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_self_describe',
      description:
        'Runtime self-introspection — returns active surface policy, effective tier (with tier-3 session info), cognitive mode, full tool inventory with availability, feature flags, and cross-surface tier-3 sessions. Use this BEFORE answering "what can you do" — never hallucinate capabilities from training data.',
      inputSchema: {
        type: 'object',
        properties: {
          surface: { type: 'string', description: 'Override active surface name' },
          actorId: { type: 'string', description: 'Actor id for tier-3 lookup' },
        },
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      validateInput(args) {
        return {
          surface: optionalString(args, 'surface'),
          actorId: optionalString(args, 'actorId'),
        };
      },
      async execute(input) {
        const surface = input.surface ?? activeSurface ?? 'mcp';
        return runMemphisSelfDescribe({ ...input, surface }, rawEnv);
      },
    }),
    // ─── S5 self-coding plan/execute/review/PR/verify (PR #593) ──────────
    // The plan tools are data-layer (read/write tier-0 JSON state).
    // Wired into the in-process executor so an agent loop can call them
    // directly without re-entering the MCP layer.
    buildTool({
      name: 'memphis_self_plan_create',
      description:
        'Open a durable multi-step self-coding plan. Returns plan_id for use with memphis_self_plan_{get,advance,cancel} and the step-aware mode of memphis_self_modify.',
      inputSchema: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'Operator-facing one-line goal.' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: { description: { type: 'string' } },
              required: ['description'],
            },
            description: 'Ordered list of steps, each {description}.',
          },
        },
        required: ['goal', 'steps'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        const goal = requiredString(args, 'goal');
        const rawSteps = (args as { steps?: unknown }).steps;
        if (!Array.isArray(rawSteps)) {
          throw new AppError('VALIDATION_ERROR', 'steps must be an array', 400);
        }
        const steps = rawSteps.map((s, i) => {
          if (!s || typeof s !== 'object') {
            throw new AppError('VALIDATION_ERROR', `steps[${i}] must be an object`, 400);
          }
          const description = (s as { description?: unknown }).description;
          if (typeof description !== 'string' || description.trim().length === 0) {
            throw new AppError(
              'VALIDATION_ERROR',
              `steps[${i}].description is required`,
              400,
            );
          }
          return { description };
        });
        return { goal, steps };
      },
      execute(input) {
        return runMemphisSelfPlanCreate(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_get',
      description:
        'Read a self-coding plan by id. Returns {plan, next_step}; next_step surfaces the first pending or failed step (failed first, so retries resume before new work).',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string' } },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { plan_id: requiredString(args, 'plan_id') };
      },
      execute(input) {
        return runMemphisSelfPlanGet(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_advance',
      description:
        'Mark a plan step as in_progress/done/failed/skipped/pending. attempts auto-increments on in_progress/failed. Passing artifact clears lastError on the step.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          step_idx: { type: 'number' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'done', 'failed', 'skipped'],
          },
          artifact: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['plan_id', 'step_idx', 'status'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        const status = requiredString(args, 'status') as
          | 'pending'
          | 'in_progress'
          | 'done'
          | 'failed'
          | 'skipped';
        const stepIdxRaw = (args as { step_idx?: unknown }).step_idx;
        if (typeof stepIdxRaw !== 'number' || !Number.isFinite(stepIdxRaw)) {
          throw new AppError('VALIDATION_ERROR', 'step_idx must be a number', 400);
        }
        return {
          plan_id: requiredString(args, 'plan_id'),
          step_idx: stepIdxRaw,
          status,
          artifact: optionalString(args, 'artifact'),
          error: optionalString(args, 'error'),
        };
      },
      execute(input) {
        return runMemphisSelfPlanAdvance(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_plan_cancel',
      description:
        'Cancel a self-coding plan with a reason recorded on the first non-terminal step for audit.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['plan_id', 'reason'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          reason: requiredString(args, 'reason'),
        };
      },
      execute(input) {
        return runMemphisSelfPlanCancel(input, rawEnv);
      },
    }),
    buildTool({
      name: 'memphis_self_review',
      description:
        'Pre-PR review: gap (step done with no artifact), unfinished steps, scope creep (files not named by any step), TODO/FIXME/XXX/HACK markers added in plan diff. Returns {ok, checklist, blockers[]}.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string' } },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { plan_id: requiredString(args, 'plan_id') };
      },
      async execute(input) {
        return runMemphisSelfReview(input, { rawEnv: rawEnv });
      },
    }),
    buildTool({
      name: 'memphis_self_pr_open',
      description:
        'Push the plan branch and open a PR via gh. Auto-derives title from plan.goal and body from step list. Sets plan status pr-open + records prUrl. Memphis NEVER merges — operator-only.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          title: { type: 'string' },
          body_prefix: { type: 'string' },
          branch: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['plan_id'],
      },
      isConcurrencySafe: false,
      isReadOnly: false,
      isDestructive: false,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          title: optionalString(args, 'title'),
          body_prefix: optionalString(args, 'body_prefix'),
          branch: optionalString(args, 'branch'),
          base: optionalString(args, 'base'),
        };
      },
      async execute(input) {
        return runMemphisSelfPrOpen(input, { rawEnv: rawEnv });
      },
    }),
    buildTool({
      name: 'memphis_self_deploy_verify',
      description:
        'C-step: confirm merged PR shipped — three checks (PR merged, merge commit on origin/main, build artifact newer than merge timestamp). Sets plan status `done` on all-green.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          build_artifact_path: { type: 'string' },
          base: { type: 'string' },
        },
        required: ['plan_id'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          plan_id: requiredString(args, 'plan_id'),
          build_artifact_path: optionalString(args, 'build_artifact_path'),
          base: optionalString(args, 'base'),
        };
      },
      async execute(input) {
        return runMemphisSelfDeployVerify(input, { rawEnv: rawEnv });
      },
    })
  ];
}
