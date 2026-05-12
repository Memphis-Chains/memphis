/**
 * S5 A.5.5 — memphis_self_pr_open handler.
 *
 * runCommand is injected so we never touch real git/gh. Each test
 * configures a script of expected commands and their canned outputs;
 * unexpected calls throw to catch any drift in the call sequence.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildPrBody,
  runMemphisSelfPrOpen,
} from '../../src/mcp/tools/self-pr-open.js';
import {
  advanceStep,
  createPlan,
  getPlan,
} from '../../src/modules/self-coding/plan-store.js';

interface Cmd {
  cmd: string;
  args: string[];
  stdout: string;
}

function scriptedRunner(script: Cmd[]) {
  let idx = 0;
  return async (cmd: string, args: string[]) => {
    if (idx >= script.length) {
      throw new Error(`unexpected command #${idx}: ${cmd} ${args.join(' ')}`);
    }
    const expected = script[idx];
    idx += 1;
    if (cmd !== expected.cmd) {
      throw new Error(`step ${idx - 1}: expected cmd ${expected.cmd}, got ${cmd}`);
    }
    // For args we only assert prefix to keep test brittleness low (gh
    // pr create has long varying args)
    for (let i = 0; i < Math.min(expected.args.length, args.length); i += 1) {
      if (expected.args[i] && expected.args[i] !== args[i]) {
        throw new Error(
          `step ${idx - 1}: arg ${i} expected ${expected.args[i]}, got ${args[i]}`,
        );
      }
    }
    return { stdout: expected.stdout };
  };
}

describe('memphis_self_pr_open', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-pr-open-'));
    env = { ...process.env, MEMPHIS_HOME: home, MEMPHIS_SELF_CODING_PLANS: '1' };
  });

  afterEach(() => {
    if (env.MEMPHIS_HOME) rmSync(env.MEMPHIS_HOME, { recursive: true, force: true });
  });

  function makeReadyPlan() {
    const { plan } = createPlan(
      {
        goal: 'add memphis_weather tool',
        steps: [{ description: 's0' }, { description: 's1' }],
      },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'abc123' }, env);
    advanceStep({ planId: plan.id, stepIdx: 1, status: 'done', artifact: 'def456' }, env);
    return getPlan(plan.id, env)!;
  }

  it('happy path: detects branch, pushes, opens PR, records prUrl', async () => {
    const plan = makeReadyPlan();
    const script: Cmd[] = [
      { cmd: 'git', args: ['rev-parse'], stdout: 'feat/weather\n' },
      { cmd: 'git', args: ['push', '-u', 'origin', 'feat/weather'], stdout: '' },
      {
        cmd: 'gh',
        args: ['pr', 'create'],
        stdout: 'Creating pull request for feat/weather into main\nhttps://github.com/x/y/pull/42\n',
      },
    ];
    const result = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: scriptedRunner(script) },
    );
    expect(result.ok).toBe(true);
    expect(result.pr_url).toBe('https://github.com/x/y/pull/42');
    expect(result.branch).toBe('feat/weather');
    const updated = getPlan(plan.id, env)!;
    expect(updated.status).toBe('pr-open');
    expect(updated.prUrl).toBe('https://github.com/x/y/pull/42');
    expect(updated.branch).toBe('feat/weather');
  });

  it('refuses when plan has unfinished steps', async () => {
    const { plan } = createPlan(
      { goal: 'g', steps: [{ description: 's0' }, { description: 's1' }] },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'a' }, env);
    // step 1 left as pending
    const result = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      {
        rawEnv: env,
        runCommand: async () => {
          throw new Error('should not be called');
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not done or skipped');
  });

  it('refuses when plan has zero done steps (only skipped)', async () => {
    const { plan } = createPlan(
      { goal: 'g', steps: [{ description: 's0' }] },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'skipped' }, env);
    const result = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      {
        rawEnv: env,
        runCommand: async () => ({ stdout: '' }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nothing to ship');
  });

  it('refuses to open from main branch', async () => {
    const plan = makeReadyPlan();
    const script: Cmd[] = [{ cmd: 'git', args: ['rev-parse'], stdout: 'main\n' }];
    const result = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: scriptedRunner(script) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('refusing to open PR from default branch');
  });

  it('refuses when plan already has PR open', async () => {
    const plan = makeReadyPlan();
    const script: Cmd[] = [
      { cmd: 'git', args: ['rev-parse'], stdout: 'feat/x\n' },
      { cmd: 'git', args: ['push'], stdout: '' },
      { cmd: 'gh', args: ['pr', 'create'], stdout: 'https://github.com/x/y/pull/1\n' },
    ];
    const first = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: scriptedRunner(script) },
    );
    expect(first.ok).toBe(true);

    const second = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      {
        rawEnv: env,
        runCommand: async () => {
          throw new Error('should not run');
        },
      },
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain('already has PR open');
  });

  it('surfaces gh pr create failure cleanly', async () => {
    const plan = makeReadyPlan();
    const script: Cmd[] = [
      { cmd: 'git', args: ['rev-parse'], stdout: 'feat/x\n' },
      { cmd: 'git', args: ['push'], stdout: '' },
    ];
    const runner = scriptedRunner(script);
    const wrappedRunner = async (cmd: string, args: string[]) => {
      if (cmd === 'gh') {
        throw new Error('GraphQL: gh auth required');
      }
      return runner(cmd, args);
    };
    const result = await runMemphisSelfPrOpen(
      { plan_id: plan.id },
      { rawEnv: env, runCommand: wrappedRunner },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('gh pr create failed');
  });

  it('returns ok=false on unknown plan id', async () => {
    const result = await runMemphisSelfPrOpen(
      { plan_id: 'bogus' },
      { rawEnv: env, runCommand: async () => ({ stdout: '' }) },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('plan not found');
  });
});

describe('buildPrBody', () => {
  it('emits a step list with status markers + artifact links', () => {
    const plan = {
      id: 'plan-x',
      goal: 'add memphis_weather',
      steps: [
        { idx: 0, description: 'register', status: 'done' as const, artifact: 'abc', attempts: 1 },
        { idx: 1, description: 'skipped', status: 'skipped' as const, attempts: 0 },
        {
          idx: 2,
          description: 'retry-then-pass',
          status: 'done' as const,
          artifact: 'def',
          attempts: 3,
        },
      ],
      status: 'reviewing' as const,
      createdBy: 'memphis' as const,
      createdAt: '2026-05-12T20:00:00Z',
      updatedAt: '2026-05-12T20:30:00Z',
    };
    const body = buildPrBody(plan);
    expect(body).toContain('## Summary');
    expect(body).toContain('add memphis_weather');
    expect(body).toContain('- [x] **#0** register — `abc`');
    expect(body).toContain('- [~] **#1** skipped');
    expect(body).toContain('(attempts: 3)');
    expect(body).toContain('plan_id: `plan-x`');
  });
});
