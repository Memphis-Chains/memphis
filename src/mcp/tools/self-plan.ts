/**
 * S5 A.5.2 — MCP tools for the self-coding plan-store.
 *
 * Four tools matching the spec in docs/dev/sprint-plan-2026-05-12.md:
 *
 * - memphis_self_plan_create({ goal, steps }) → { plan_id, persisted }
 * - memphis_self_plan_get({ plan_id }) → { plan, next_step }
 * - memphis_self_plan_advance({ plan_id, step_idx, status, artifact?, error? }) → { plan, next_step }
 * - memphis_self_plan_cancel({ plan_id, reason }) → { plan }
 *
 * The handlers are thin shims over `plan-store.ts`. The store is the
 * authority; tools translate input shapes, normalize errors, and
 * compute the next-step convenience field so the LLM can stay on plan
 * without re-reading the full step list every turn.
 */

import {
  advanceStep,
  cancelPlan,
  createPlan,
  getPlan,
  nextPendingStep,
} from '../../modules/self-coding/plan-store.js';
import type {
  PlanStepStatus,
  SelfCodingPlan,
  SelfCodingPlanStep,
} from '../../modules/self-coding/plan-types.js';

export interface PlanCreateInput {
  goal: string;
  steps: Array<{ description: string }>;
}

export interface PlanCreateOutput {
  ok: true;
  plan_id: string;
  persisted: boolean;
  plan: SelfCodingPlan;
}

export interface PlanGetInput {
  plan_id: string;
}

export interface PlanGetOutput {
  ok: boolean;
  plan?: SelfCodingPlan;
  next_step?: SelfCodingPlanStep;
  error?: string;
}

export interface PlanAdvanceInput {
  plan_id: string;
  step_idx: number;
  status: PlanStepStatus;
  artifact?: string;
  error?: string;
}

export interface PlanAdvanceOutput {
  ok: boolean;
  plan?: SelfCodingPlan;
  next_step?: SelfCodingPlanStep;
  error?: string;
}

export interface PlanCancelInput {
  plan_id: string;
  reason: string;
}

export interface PlanCancelOutput {
  ok: boolean;
  plan?: SelfCodingPlan;
  error?: string;
}

export function runMemphisSelfPlanCreate(
  input: PlanCreateInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): PlanCreateOutput {
  const { plan, persisted } = createPlan(
    { goal: input.goal, steps: input.steps },
    rawEnv,
  );
  return { ok: true, plan_id: plan.id, persisted, plan };
}

export function runMemphisSelfPlanGet(
  input: PlanGetInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): PlanGetOutput {
  if (!input.plan_id || input.plan_id.trim().length === 0) {
    return { ok: false, error: 'plan_id is required' };
  }
  const plan = getPlan(input.plan_id, rawEnv);
  if (!plan) {
    return { ok: false, error: `plan not found: ${input.plan_id}` };
  }
  const next = nextPendingStep(plan);
  return { ok: true, plan, next_step: next ?? undefined };
}

export function runMemphisSelfPlanAdvance(
  input: PlanAdvanceInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): PlanAdvanceOutput {
  if (!input.plan_id || input.plan_id.trim().length === 0) {
    return { ok: false, error: 'plan_id is required' };
  }
  if (typeof input.step_idx !== 'number' || !Number.isInteger(input.step_idx) || input.step_idx < 0) {
    return { ok: false, error: 'step_idx must be a non-negative integer' };
  }
  let plan;
  try {
    plan = advanceStep(
      {
        planId: input.plan_id,
        stepIdx: input.step_idx,
        status: input.status,
        artifact: input.artifact,
        error: input.error,
      },
      rawEnv,
    );
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!plan) {
    return {
      ok: false,
      error: `plan not found or step idx out of range: ${input.plan_id}#${input.step_idx}`,
    };
  }
  const next = nextPendingStep(plan);
  return { ok: true, plan, next_step: next ?? undefined };
}

export function runMemphisSelfPlanCancel(
  input: PlanCancelInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): PlanCancelOutput {
  if (!input.plan_id || input.plan_id.trim().length === 0) {
    return { ok: false, error: 'plan_id is required' };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { ok: false, error: 'reason is required' };
  }
  const plan = cancelPlan(input.plan_id, input.reason.trim(), rawEnv);
  if (!plan) {
    return { ok: false, error: `plan not found: ${input.plan_id}` };
  }
  return { ok: true, plan };
}
