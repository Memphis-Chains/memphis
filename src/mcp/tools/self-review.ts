/**
 * memphis_self_review — A.5.4.
 *
 * Wires the pure-logic `runPlanReview` (src/modules/self-coding/plan-review.ts)
 * to live git via execFile. Run before `memphis_self_pr_open` to make
 * sure the plan didn't drift (steps without artifact, files outside
 * named steps, TODO/FIXME debt added in this plan's diff).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  runPlanReview,
  type DiffLineMatch,
  type DiffProbe,
  type ReviewResult,
} from '../../modules/self-coding/plan-review.js';
import { getPlan } from '../../modules/self-coding/plan-store.js';
import type { SelfCodingPlan } from '../../modules/self-coding/plan-types.js';

const execFileAsync = promisify(execFile);

export interface SelfReviewInput {
  plan_id: string;
}

export interface SelfReviewOutput extends Partial<ReviewResult> {
  ok: boolean;
  error?: string;
}

async function resolvePlanBaseline(
  plan: SelfCodingPlan,
  projectRoot: string,
): Promise<string> {
  // Prefer the plan's branch base (merge-base with main) so the diff
  // is exactly "what this plan added". Fall back to HEAD~1 only as a
  // last resort — it would otherwise lump a chain of plan commits
  // together and produce noisy scope-creep flags.
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', 'main'], {
      cwd: projectRoot,
    });
    return stdout.trim();
  } catch {
    return 'HEAD~1';
  }
}

class GitDiffProbe implements DiffProbe {
  private baselineCache = new Map<string, Promise<string>>();

  constructor(private readonly projectRoot: string) {}

  private async baseline(plan: SelfCodingPlan): Promise<string> {
    const cached = this.baselineCache.get(plan.id);
    if (cached) return cached;
    const fresh = resolvePlanBaseline(plan, this.projectRoot);
    this.baselineCache.set(plan.id, fresh);
    return fresh;
  }

  async changedFiles(plan: SelfCodingPlan): Promise<string[]> {
    const base = await this.baseline(plan);
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', `${base}...HEAD`],
        { cwd: this.projectRoot, maxBuffer: 4 * 1024 * 1024 },
      );
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch {
      return [];
    }
  }

  async addedLinesMatching(
    plan: SelfCodingPlan,
    pattern: RegExp,
  ): Promise<DiffLineMatch[]> {
    const base = await this.baseline(plan);
    let stdout = '';
    try {
      const result = await execFileAsync(
        'git',
        ['diff', '--unified=0', `${base}...HEAD`],
        { cwd: this.projectRoot, maxBuffer: 16 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch {
      return [];
    }
    const matches: DiffLineMatch[] = [];
    let currentFile: string | null = null;
    for (const raw of stdout.split('\n')) {
      if (raw.startsWith('+++ b/')) {
        currentFile = raw.slice('+++ b/'.length);
        continue;
      }
      if (raw.startsWith('+++ ')) {
        currentFile = null;
        continue;
      }
      if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
      const line = raw.slice(1);
      if (pattern.test(line) && currentFile) {
        matches.push({ file: currentFile, line: line.trim() });
      }
    }
    return matches;
  }
}

export interface SelfReviewDeps {
  projectRoot?: string;
  probe?: DiffProbe;
  rawEnv?: NodeJS.ProcessEnv;
}

export async function runMemphisSelfReview(
  input: SelfReviewInput,
  deps: SelfReviewDeps = {},
): Promise<SelfReviewOutput> {
  if (!input.plan_id || input.plan_id.trim().length === 0) {
    return { ok: false, error: 'plan_id is required' };
  }
  const plan = getPlan(input.plan_id, deps.rawEnv);
  if (!plan) {
    return { ok: false, error: `plan not found: ${input.plan_id}` };
  }
  const projectRoot = deps.projectRoot ?? process.cwd();
  const probe = deps.probe ?? new GitDiffProbe(projectRoot);
  const result = await runPlanReview(plan, probe);
  return {
    ok: result.ok,
    plan_id: result.plan_id,
    checklist: result.checklist,
    blockers: result.blockers,
  };
}
