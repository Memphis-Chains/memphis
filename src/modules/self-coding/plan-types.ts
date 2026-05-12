/**
 * Self-coding plan types — durable state for multi-turn feature work.
 *
 * S5 sprint, A.5.1 (PR introduces the store; tools in A.5.2 follow).
 * See docs/dev/sprint-plan-2026-05-12.md for the full design.
 */

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export type PlanStatus =
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'pr-open'
  | 'done'
  | 'cancelled';

export type PlanCreator = 'memphis' | 'operator';

export interface SelfCodingPlanStep {
  idx: number;
  description: string;
  status: PlanStepStatus;
  artifact?: string;
  attempts: number;
  lastError?: string;
}

export interface SelfCodingPlan {
  id: string;
  goal: string;
  steps: SelfCodingPlanStep[];
  status: PlanStatus;
  createdBy: PlanCreator;
  createdAt: string;
  updatedAt: string;
  branch?: string;
  prUrl?: string;
}

export interface PlanStepInput {
  description: string;
}

export interface PlanCreateInput {
  goal: string;
  steps: PlanStepInput[];
  createdBy?: PlanCreator;
}

export interface PlanAdvanceInput {
  planId: string;
  stepIdx: number;
  status: PlanStepStatus;
  artifact?: string;
  error?: string;
}
