/**
 * S5 A.5.6 — memphis_self_deploy_verify handler.
 *
 * Injects runCommand + statFn so we can simulate gh + git + fs without
 * touching the real environment. Each test configures a script of
 * expected (cmd, args) → stdout pairs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisSelfDeployVerify } from '../../src/mcp/tools/self-deploy-verify.js';
import {
  createPlan,
  advanceStep,
  getPlan,
  setPlanStatus,
} from '../../src/modules/self-coding/plan-store.js';

interface ScriptCmd {
  cmd: string;
  argsContain: string;
  stdout: string;
  throws?: string;
}

function scriptedRunner(script: ScriptCmd[]) {
  let i = 0;
  return async (cmd: string, args: string[]) => {
    const expected = script[i];
    if (!expected) {
      throw new Error(`unexpected command #${i}: ${cmd} ${args.join(' ')}`);
    }
    i += 1;
    if (cmd !== expected.cmd) {
      throw new Error(`step ${i - 1}: expected ${expected.cmd}, got ${cmd}`);
    }
    if (!args.join(' ').includes(expected.argsContain)) {
      throw new Error(
        `step ${i - 1}: expected args to contain "${expected.argsContain}", got "${args.join(' ')}"`,
      );
    }
    if (expected.throws) {
      throw new Error(expected.throws);
    }
    return { stdout: expected.stdout };
  };
}

describe('memphis_self_deploy_verify', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-deploy-verify-'));
    env = { ...process.env, MEMPHIS_HOME: home, MEMPHIS_SELF_CODING_PLANS: '1' };
  });

  afterEach(() => {
    if (env.MEMPHIS_HOME) rmSync(env.MEMPHIS_HOME, { recursive: true, force: true });
  });

  function readyPlan(prUrl: string) {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's' }] }, env);
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'abc' }, env);
    setPlanStatus({ planId: plan.id, status: 'pr-open', branch: 'feat/x', prUrl }, env);
    return getPlan(plan.id, env)!;
  }

  it('happy path: PR merged + commit on origin/main + build newer → plan done', async () => {
    const plan = readyPlan('https://github.com/x/y/pull/42');
    const mergedAt = new Date(Date.now() - 60_000).toISOString();
    const buildMtime = Date.now(); // after merge
    const script: ScriptCmd[] = [
      {
        cmd: 'gh',
        argsContain: 'pr view',
        stdout: JSON.stringify({
          merged: true,
          mergeCommit: { oid: 'abc123def' },
          mergedAt,
        }),
      },
      { cmd: 'git', argsContain: 'fetch origin main', stdout: '' },
      { cmd: 'git', argsContain: 'merge-base --is-ancestor', stdout: '' },
    ];
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id, build_artifact_path: '/fake/dist' },
      {
        rawEnv: env,
        runCommand: scriptedRunner(script),
        statFn: () => ({ mtimeMs: buildMtime }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.status_after).toBe('done');
    expect(result.checks.map((c) => c.ok)).toEqual([true, true, true]);
    const final = getPlan(plan.id, env)!;
    expect(final.status).toBe('done');
  });

  it('fails when PR is not merged yet', async () => {
    const plan = readyPlan('https://github.com/x/y/pull/42');
    const script: ScriptCmd[] = [
      {
        cmd: 'gh',
        argsContain: 'pr view',
        stdout: JSON.stringify({ merged: false }),
      },
    ];
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: scriptedRunner(script), statFn: () => ({ mtimeMs: 0 }) },
    );
    expect(result.ok).toBe(false);
    expect(result.checks[0].ok).toBe(false);
    expect(result.checks[0].detail).toContain('not merged yet');
    // status NOT flipped to done
    expect(getPlan(plan.id, env)?.status).toBe('pr-open');
  });

  it('fails when build mtime is older than merge time', async () => {
    const plan = readyPlan('https://github.com/x/y/pull/42');
    const mergedAt = new Date().toISOString();
    const staleBuildMtime = Date.now() - 10 * 60 * 1000; // 10 min before merge
    const script: ScriptCmd[] = [
      {
        cmd: 'gh',
        argsContain: 'pr view',
        stdout: JSON.stringify({
          merged: true,
          mergeCommit: { oid: 'abc' },
          mergedAt,
        }),
      },
      { cmd: 'git', argsContain: 'fetch', stdout: '' },
      { cmd: 'git', argsContain: 'merge-base', stdout: '' },
    ];
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id, build_artifact_path: '/fake/dist' },
      {
        rawEnv: env,
        runCommand: scriptedRunner(script),
        statFn: () => ({ mtimeMs: staleBuildMtime }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'build_artifact_newer_than_merge')?.ok).toBe(false);
    expect(getPlan(plan.id, env)?.status).toBe('pr-open');
  });

  it('fails when merge commit not yet on origin/main', async () => {
    const plan = readyPlan('https://github.com/x/y/pull/42');
    const script: ScriptCmd[] = [
      {
        cmd: 'gh',
        argsContain: 'pr view',
        stdout: JSON.stringify({
          merged: true,
          mergeCommit: { oid: 'abc' },
          mergedAt: new Date().toISOString(),
        }),
      },
      { cmd: 'git', argsContain: 'fetch', stdout: '' },
      {
        cmd: 'git',
        argsContain: 'merge-base --is-ancestor',
        stdout: '',
        throws: 'not an ancestor',
      },
    ];
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id, build_artifact_path: '/fake/dist' },
      {
        rawEnv: env,
        runCommand: scriptedRunner(script),
        statFn: () => ({ mtimeMs: Date.now() }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'merge_commit_in_origin_main')?.ok).toBe(false);
  });

  it('refuses on plan without prUrl', async () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's' }] }, env);
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id },
      {
        rawEnv: env,
        runCommand: async () => {
          throw new Error('should not run');
        },
        statFn: () => ({ mtimeMs: 0 }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no recorded prUrl');
  });

  it('returns ok=false on unknown plan_id', async () => {
    const result = await runMemphisSelfDeployVerify(
      { plan_id: 'bogus' },
      { rawEnv: env, runCommand: async () => ({ stdout: '' }), statFn: () => ({ mtimeMs: 0 }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('plan not found');
  });

  it('surfaces gh failure cleanly without crashing', async () => {
    const plan = readyPlan('https://github.com/x/y/pull/42');
    const wrappedRunner = async () => {
      throw new Error('gh: not authenticated');
    };
    const result = await runMemphisSelfDeployVerify(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: wrappedRunner, statFn: () => ({ mtimeMs: 0 }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('gh pr view failed');
  });
});
