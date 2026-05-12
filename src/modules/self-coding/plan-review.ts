/**
 * Plan review checks — gap, scope-creep, and TODO/FIXME debt.
 *
 * Runs in front of `memphis_self_pr_open` to make sure Memphis doesn't
 * ship a plan that:
 *   (a) claims a step is done with no recorded artifact (data corruption),
 *   (b) accumulated changes in files no plan step ever named (scope creep),
 *   (c) left TODO/FIXME breadcrumbs on lines this plan introduced.
 *
 * The per-step test gate inside `memphis_self_modify` already runs the
 * lint + typecheck + test pipeline at each commit, so this module
 * deliberately doesn't re-run those — that's wasted CI on a path where
 * a single test gate failure earlier would have already stopped the
 * plan.
 *
 * Pure logic + dependency-injected git diff probe → unit-testable
 * without a real repo. Wire-up to live git lives in the MCP tool
 * handler (src/mcp/tools/self-review.ts).
 */

import type { SelfCodingPlan } from './plan-types.js';

export interface DiffProbe {
  /** Files touched between plan baseline and current HEAD. */
  changedFiles(plan: SelfCodingPlan): Promise<string[]>;
  /**
   * Added lines (prefixed `+`) that match the supplied regex, paired
   * with the file they live in. The regex is run per-line; callers
   * pass anchored patterns like /\b(TODO|FIXME)\b/.
   */
  addedLinesMatching(plan: SelfCodingPlan, pattern: RegExp): Promise<DiffLineMatch[]>;
}

export interface DiffLineMatch {
  file: string;
  line: string;
}

export interface ReviewChecklist {
  gap_steps_no_artifact: number[];
  gap_steps_unfinished: number[];
  scope_creep_files: string[];
  todo_fixme_lines: DiffLineMatch[];
}

export interface ReviewResult {
  ok: boolean;
  plan_id: string;
  checklist: ReviewChecklist;
  blockers: string[];
}

/**
 * Heuristic for "step description names this file". Memphis writes
 * step descriptions like "implement runMemphisWeather", "register in
 * TOOL_REGISTRY", "add MCP server route" — these don't always cite a
 * literal path, so we match on:
 *   - exact path substring (e.g. "src/mcp/tools/weather.ts")
 *   - basename without extension (e.g. "weather", "tool-registry")
 *   - common shorthand tokens ("tool registry", "tool-registry")
 * The check is conservative — false negatives (real change flagged as
 * scope creep) are surfaced to the operator who can override; false
 * positives (creep slips through) are caught by manual PR review.
 */
function normalizeSeparators(s: string): string {
  // Collapse `_`, `-`, and whitespace runs into a single space so
  // "TOOL_REGISTRY", "tool-registry", and "tool registry" all compare
  // equal. Memphis step descriptions use all three idioms freely.
  return s.toLowerCase().replace(/[_\-\s]+/g, ' ');
}

function fileMatchesStep(stepDescription: string, filePath: string): boolean {
  const desc = normalizeSeparators(stepDescription);
  const path = normalizeSeparators(filePath);
  if (desc.includes(path)) return true;
  // basename without extension — the most common shorthand idiom.
  const base = path.split('/').pop() ?? path;
  const stem = base.replace(/\.[^.]+$/, '');
  if (stem.length > 2 && desc.includes(stem)) return true;
  // Compressed-no-separator form ("tool registry" vs "toolregistry"
  // / "runmemphisweather"). Strip spaces both sides and check again.
  const flatDesc = desc.replace(/\s+/g, '');
  const flatStem = stem.replace(/\s+/g, '');
  if (flatStem.length > 2 && flatDesc.includes(flatStem)) return true;
  return false;
}

export async function runPlanReview(
  plan: SelfCodingPlan,
  probe: DiffProbe,
): Promise<ReviewResult> {
  const checklist: ReviewChecklist = {
    gap_steps_no_artifact: [],
    gap_steps_unfinished: [],
    scope_creep_files: [],
    todo_fixme_lines: [],
  };

  for (const step of plan.steps) {
    if (step.status === 'done' && !step.artifact) {
      checklist.gap_steps_no_artifact.push(step.idx);
    }
    if (step.status !== 'done' && step.status !== 'skipped') {
      checklist.gap_steps_unfinished.push(step.idx);
    }
  }

  const changedFiles = await probe.changedFiles(plan);
  for (const file of changedFiles) {
    const matched = plan.steps.some((s) => fileMatchesStep(s.description, file));
    if (!matched) checklist.scope_creep_files.push(file);
  }

  checklist.todo_fixme_lines = await probe.addedLinesMatching(plan, /\b(TODO|FIXME|XXX|HACK)\b/);

  const blockers: string[] = [];
  if (checklist.gap_steps_no_artifact.length > 0) {
    blockers.push(
      `${checklist.gap_steps_no_artifact.length} step(s) marked done with no artifact: ${checklist.gap_steps_no_artifact.join(', ')}`,
    );
  }
  if (checklist.gap_steps_unfinished.length > 0) {
    blockers.push(
      `${checklist.gap_steps_unfinished.length} step(s) not done or skipped: ${checklist.gap_steps_unfinished.join(', ')}`,
    );
  }
  if (checklist.scope_creep_files.length > 0) {
    blockers.push(
      `${checklist.scope_creep_files.length} file(s) modified but not named in any step: ${checklist.scope_creep_files.slice(0, 5).join(', ')}${checklist.scope_creep_files.length > 5 ? '…' : ''}`,
    );
  }
  if (checklist.todo_fixme_lines.length > 0) {
    blockers.push(
      `${checklist.todo_fixme_lines.length} TODO/FIXME marker(s) introduced in this plan's diff`,
    );
  }

  return {
    ok: blockers.length === 0,
    plan_id: plan.id,
    checklist,
    blockers,
  };
}
