/**
 * memphis_self_deploy_verify — A.5.6.
 *
 * C-step lane: after the operator merges the PR Memphis opened in
 * A.5.5, Memphis runs this to confirm the merge actually landed and
 * the runtime carries the change. Sets plan status to `done` only on
 * a clean verdict.
 *
 * Three checks (intentionally narrow, intentionally testable):
 *   1. PR is merged (gh pr view returns merged: true, plus a merge
 *      commit sha that resolves on origin/main).
 *   2. Local main is fast-forwarded to include the merge commit (so
 *      the developer's working clone reflects what shipped).
 *   3. Built artifact (dist/ root) mtime is newer than the merge
 *      commit timestamp — proof a rebuild happened after merge.
 *
 * Out of scope for this iteration (deferred):
 *   - journalctl log-line probe (env-dependent, brittle in CI)
 *   - memphis_self_describe tool-count delta (requires recursive MCP
 *     call into the same daemon — fragile to coordinate)
 * Operator can layer those as follow-ups; the three checks here cover
 * the load-bearing "did this actually ship" question.
 */
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getPlan, setPlanStatus } from '../../modules/self-coding/plan-store.js';
import type { SelfCodingPlan } from '../../modules/self-coding/plan-types.js';

const execFileAsync = promisify(execFile);

export interface SelfDeployVerifyInput {
  plan_id: string;
  /** Override the path checked for build artifact mtime. */
  build_artifact_path?: string;
  /** Override the base branch (defaults to main). */
  base?: string;
}

export interface DeployVerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface SelfDeployVerifyOutput {
  ok: boolean;
  plan_id: string;
  status_after: string;
  checks: DeployVerifyCheck[];
  error?: string;
}

export interface SelfDeployVerifyDeps {
  projectRoot?: string;
  rawEnv?: NodeJS.ProcessEnv;
  runCommand?: (cmd: string, args: string[], cwd?: string) => Promise<{ stdout: string }>;
  /** Test seam — override fs.stat for the build artifact path. */
  statFn?: (path: string) => { mtimeMs: number };
}

function defaultRunCommand(cmd: string, args: string[], cwd?: string) {
  return execFileAsync(cmd, args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000,
  });
}

interface PrViewResult {
  merged: boolean;
  mergeCommit?: string;
  mergedAt?: string;
}

async function fetchPrStatus(
  prUrl: string,
  runCommand: NonNullable<SelfDeployVerifyDeps['runCommand']>,
  projectRoot: string,
): Promise<PrViewResult> {
  const { stdout } = await runCommand(
    'gh',
    ['pr', 'view', prUrl, '--json', 'merged,mergeCommit,mergedAt'],
    projectRoot,
  );
  const parsed = JSON.parse(stdout) as {
    merged: boolean;
    mergeCommit?: { oid?: string } | null;
    mergedAt?: string | null;
  };
  return {
    merged: Boolean(parsed.merged),
    mergeCommit: parsed.mergeCommit?.oid ?? undefined,
    mergedAt: parsed.mergedAt ?? undefined,
  };
}

async function gitContains(
  sha: string,
  branch: string,
  runCommand: NonNullable<SelfDeployVerifyDeps['runCommand']>,
  projectRoot: string,
): Promise<boolean> {
  try {
    await runCommand('git', ['merge-base', '--is-ancestor', sha, branch], projectRoot);
    return true;
  } catch {
    return false;
  }
}

export async function runMemphisSelfDeployVerify(
  input: SelfDeployVerifyInput,
  deps: SelfDeployVerifyDeps = {},
): Promise<SelfDeployVerifyOutput> {
  if (!input.plan_id || input.plan_id.trim().length === 0) {
    return {
      ok: false,
      plan_id: input.plan_id,
      status_after: '',
      checks: [],
      error: 'plan_id is required',
    };
  }
  const plan = getPlan(input.plan_id, deps.rawEnv);
  if (!plan) {
    return {
      ok: false,
      plan_id: input.plan_id,
      status_after: '',
      checks: [],
      error: `plan not found: ${input.plan_id}`,
    };
  }
  if (!plan.prUrl) {
    return {
      ok: false,
      plan_id: plan.id,
      status_after: plan.status,
      checks: [],
      error: 'plan has no recorded prUrl — open a PR via memphis_self_pr_open first',
    };
  }

  const projectRoot = deps.projectRoot ?? process.cwd();
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const statFn = deps.statFn ?? ((p: string) => statSync(p));
  const base = input.base ?? 'main';

  const checks: DeployVerifyCheck[] = [];

  // 1. PR merged check
  let pr: PrViewResult;
  try {
    pr = await fetchPrStatus(plan.prUrl, runCommand, projectRoot);
  } catch (err) {
    return {
      ok: false,
      plan_id: plan.id,
      status_after: plan.status,
      checks,
      error: `gh pr view failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mergedCheck: DeployVerifyCheck = {
    name: 'pr_merged',
    ok: pr.merged && Boolean(pr.mergeCommit),
    detail: pr.merged ? `merged at ${pr.mergedAt}, sha ${pr.mergeCommit}` : 'not merged yet',
  };
  checks.push(mergedCheck);

  // 2. Local origin/main contains the merge commit
  if (mergedCheck.ok && pr.mergeCommit) {
    // Fetch latest origin/main before checking ancestry; without this
    // the check would fire-and-fail on a stale local clone right after
    // the operator merges.
    try {
      await runCommand('git', ['fetch', 'origin', base], projectRoot);
    } catch {
      // Non-fatal — if fetch fails we just probe whatever the local
      // ref is and surface the result. Operator can re-run after
      // fixing network/credentials.
    }
    const inMain = await gitContains(
      pr.mergeCommit,
      `origin/${base}`,
      runCommand,
      projectRoot,
    );
    checks.push({
      name: 'merge_commit_in_origin_main',
      ok: inMain,
      detail: inMain
        ? `${pr.mergeCommit} is an ancestor of origin/${base}`
        : `${pr.mergeCommit} NOT yet on origin/${base} — fetch + retry`,
    });
  } else {
    checks.push({
      name: 'merge_commit_in_origin_main',
      ok: false,
      detail: 'skipped — PR not merged yet',
    });
  }

  // 3. Build artifact is newer than merge timestamp
  const buildPath = input.build_artifact_path ?? join(projectRoot, 'dist');
  if (mergedCheck.ok && pr.mergedAt) {
    let buildOk = false;
    let buildDetail = '';
    try {
      const stat = statFn(buildPath);
      const buildMs = stat.mtimeMs;
      const mergedMs = new Date(pr.mergedAt).getTime();
      buildOk = Number.isFinite(buildMs) && buildMs >= mergedMs;
      buildDetail = `build mtime ${new Date(buildMs).toISOString()}, merged ${pr.mergedAt}`;
    } catch (err) {
      buildDetail = `cannot stat ${buildPath}: ${err instanceof Error ? err.message : String(err)}`;
    }
    checks.push({
      name: 'build_artifact_newer_than_merge',
      ok: buildOk,
      detail: buildDetail,
    });
  } else {
    checks.push({
      name: 'build_artifact_newer_than_merge',
      ok: false,
      detail: 'skipped — PR not merged yet',
    });
  }

  const allOk = checks.every((c) => c.ok);
  let statusAfter = plan.status;
  if (allOk) {
    const updated = setPlanStatus({ planId: plan.id, status: 'done' }, deps.rawEnv);
    statusAfter = updated?.status ?? plan.status;
  }
  return {
    ok: allOk,
    plan_id: plan.id,
    status_after: statusAfter,
    checks,
  };
}

export type { SelfCodingPlan };
