/**
 * S5 A.5.1 plan-store invariants.
 *
 * Coverage: create → advance → setStatus → cancel; persistence
 * round-trip; tampering rejection; feature-gate; GC of stale terminal
 * plans.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  advanceStep,
  cancelPlan,
  clearAllPlans,
  createPlan,
  getPersistencePath,
  getPlan,
  loadAllPlans,
  nextPendingStep,
  setPlanStatus,
} from '../../src/modules/self-coding/plan-store.js';

function makeEnv(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(tmpdir(), 'memphis-plan-store-'));
  return { ...process.env, MEMPHIS_HOME: home, MEMPHIS_SELF_CODING_PLANS: '1' };
}

describe('self-coding plan-store', () => {
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    env = makeEnv();
  });

  afterEach(() => {
    if (env.MEMPHIS_HOME) {
      rmSync(env.MEMPHIS_HOME, { recursive: true, force: true });
    }
  });

  it('createPlan rejects empty goal and empty steps', () => {
    expect(() => createPlan({ goal: '', steps: [{ description: 'x' }] }, env)).toThrow();
    expect(() => createPlan({ goal: 'g', steps: [] }, env)).toThrow();
    expect(() => createPlan({ goal: 'g', steps: [{ description: '   ' }] }, env)).toThrow();
  });

  it('createPlan persists and round-trips through loadAllPlans', () => {
    const { plan, persisted } = createPlan(
      {
        goal: 'add memphis_weather tool',
        steps: [
          { description: 'register in TOOL_REGISTRY' },
          { description: 'implement runMemphisWeather' },
          { description: 'wire into executor' },
          { description: 'add MCP server route' },
          { description: 'unit test' },
          { description: 'update doctor tool-count expectation' },
        ],
      },
      env,
    );
    expect(persisted).toBe(true);
    expect(plan.id).toMatch(/^plan-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/);
    expect(plan.status).toBe('planning');
    expect(plan.steps.map((s) => s.idx)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.steps.every((s) => s.status === 'pending' && s.attempts === 0)).toBe(true);

    const round = loadAllPlans(env);
    expect(round).toHaveLength(1);
    expect(round[0].id).toBe(plan.id);
    expect(round[0].goal).toBe('add memphis_weather tool');
  });

  it('advanceStep bumps attempts on in_progress/failed only', () => {
    const { plan } = createPlan(
      { goal: 'g', steps: [{ description: 's0' }, { description: 's1' }] },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'in_progress' }, env);
    let cur = getPlan(plan.id, env);
    expect(cur?.steps[0].attempts).toBe(1);
    expect(cur?.status).toBe('executing');

    advanceStep(
      { planId: plan.id, stepIdx: 0, status: 'failed', error: 'tests red' },
      env,
    );
    cur = getPlan(plan.id, env);
    expect(cur?.steps[0].attempts).toBe(2);
    expect(cur?.steps[0].lastError).toBe('tests red');

    advanceStep(
      { planId: plan.id, stepIdx: 0, status: 'done', artifact: 'src/x.ts' },
      env,
    );
    cur = getPlan(plan.id, env);
    expect(cur?.steps[0].attempts).toBe(2);
    expect(cur?.steps[0].status).toBe('done');
    expect(cur?.steps[0].artifact).toBe('src/x.ts');
    expect(cur?.steps[0].lastError).toBeUndefined();
  });

  it('advanceStep returns null on bad plan id or step idx', () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    expect(advanceStep({ planId: 'bogus', stepIdx: 0, status: 'done' }, env)).toBeNull();
    expect(advanceStep({ planId: plan.id, stepIdx: 99, status: 'done' }, env)).toBeNull();
    expect(advanceStep({ planId: plan.id, stepIdx: -1, status: 'done' }, env)).toBeNull();
  });

  it('setPlanStatus records branch and prUrl', () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    const updated = setPlanStatus(
      { planId: plan.id, status: 'pr-open', branch: 'feat/x', prUrl: 'https://example.com/pr/1' },
      env,
    );
    expect(updated?.branch).toBe('feat/x');
    expect(updated?.prUrl).toBe('https://example.com/pr/1');
    expect(updated?.status).toBe('pr-open');
  });

  it('cancelPlan moves status to cancelled and records reason on first non-terminal step', () => {
    const { plan } = createPlan(
      { goal: 'g', steps: [{ description: 's0' }, { description: 's1' }] },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'x' }, env);
    const cancelled = cancelPlan(plan.id, 'operator changed direction', env);
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.steps[0].lastError).toBeUndefined(); // already done
    expect(cancelled?.steps[1].lastError).toContain('operator changed direction');
  });

  it('nextPendingStep returns first pending OR failed step', () => {
    const { plan } = createPlan(
      {
        goal: 'g',
        steps: [{ description: 's0' }, { description: 's1' }, { description: 's2' }],
      },
      env,
    );
    advanceStep({ planId: plan.id, stepIdx: 0, status: 'done', artifact: 'x' }, env);
    advanceStep({ planId: plan.id, stepIdx: 1, status: 'failed', error: 'e' }, env);
    const reloaded = getPlan(plan.id, env)!;
    const next = nextPendingStep(reloaded);
    expect(next?.idx).toBe(1); // failed retry comes before pending s2
  });

  it('loadAllPlans rejects tampered entries (bad step idx ordering)', () => {
    const { plan } = createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    // Tamper: shuffle step idx
    const filePath = getPersistencePath(env);
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    raw[0].steps.push({
      idx: 99,
      description: 'injected',
      status: 'pending',
      attempts: 0,
    });
    writeFileSync(filePath, JSON.stringify(raw, null, 2));
    const reloaded = loadAllPlans(env);
    expect(reloaded.find((p) => p.id === plan.id)).toBeUndefined();
  });

  it('loadAllPlans tolerates non-array file shape without crashing', () => {
    const filePath = getPersistencePath(env);
    // Ensure parent dir
    createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    writeFileSync(filePath, '{"not": "an array"}');
    expect(loadAllPlans(env)).toEqual([]);
  });

  it('feature gate disables persistence (no file, no return from get)', () => {
    const gated = { ...env, MEMPHIS_SELF_CODING_PLANS: '0' };
    const { persisted } = createPlan(
      { goal: 'g', steps: [{ description: 's0' }] },
      gated,
    );
    expect(persisted).toBe(false);
    expect(existsSync(getPersistencePath(gated))).toBe(false);
    expect(loadAllPlans(gated)).toEqual([]);
  });

  it('garbage-collects terminal plans older than 30 days, keeps active plans forever', () => {
    const { plan: active } = createPlan({ goal: 'a', steps: [{ description: 's' }] }, env);
    const { plan: stale } = createPlan({ goal: 's', steps: [{ description: 's' }] }, env);
    cancelPlan(stale.id, 'old', env);
    // Backdate the cancelled plan's updatedAt to 31 days ago
    const filePath = getPersistencePath(env);
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    const staleEntry = raw.find((p: { id: string }) => p.id === stale.id);
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    staleEntry.updatedAt = thirtyOneDaysAgo;
    writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const reloaded = loadAllPlans(env);
    expect(reloaded.find((p) => p.id === active.id)).toBeDefined();
    expect(reloaded.find((p) => p.id === stale.id)).toBeUndefined();
  });

  it('clearAllPlans removes the state file', () => {
    createPlan({ goal: 'g', steps: [{ description: 's0' }] }, env);
    expect(existsSync(getPersistencePath(env))).toBe(true);
    clearAllPlans(env);
    expect(existsSync(getPersistencePath(env))).toBe(false);
  });
});
