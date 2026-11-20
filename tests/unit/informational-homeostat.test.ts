import { describe, expect, it } from 'vitest';

import {
  HOMEIOSTAT_DEGRADABLE_TASK_IDS,
  decideInformationalHomeostat,
  describeHomeostatRequest,
  homeostatActivityStatus,
  readHomeostatPolicy,
  runInformationalHomeostat,
  type HomeostatPolicy,
} from '../../src/infra/runtime/informational-homeostat.js';

const POLICY: HomeostatPolicy = {
  allowed: ['degrade-mode', 'escalate'],
  maxEvidenceAgeMs: 60 * 60 * 1000,
  cooldownMs: 6 * 60 * 60 * 1000,
};

const NOW = Date.parse('2026-11-20T12:00:00Z');

function decide(
  overrides: Partial<Parameters<typeof decideInformationalHomeostat>[0]> = {},
): ReturnType<typeof decideInformationalHomeostat> {
  return decideInformationalHomeostat({
    evidence: {
      failingSlos: [],
      unavailableSlos: [],
      evidenceAgeMs: 1000,
      activityStatusBySlo: {},
    },
    policy: POLICY,
    nowMs: NOW,
    ...overrides,
  });
}

describe('the informational homeostat decides', () => {
  it('does nothing when no gated SLO is failing', () => {
    const decision = decide();
    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('no gated SLO is failing');
  });

  it('does nothing when the evidence behind the failure is stale', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 5 * 60 * 60 * 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('stale failure is not a current fault');
  });

  it('does nothing when there is no evidence at all', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: ['tool_error_rate'],
        evidenceAgeMs: null,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('there is nothing to act on');
  });

  it('does nothing when the last activity of that class ended ok', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'ok' },
      },
    });
    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('the window average is not a current fault');
  });

  it('sheds the optional background work when the runtime tools are failing', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('degrade-mode');
    expect(decision.slo).toBe('tool_error_rate');
    expect(decision.request).toBe('shed-load');
  });

  it('asks for a restart when the provider layer is unreachable', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['provider_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { provider_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('escalate');
    expect(decision.request).toBe('restart');
  });

  it('escalates a metric it cannot classify instead of guessing', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['some_metric_from_the_future'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { some_metric_from_the_future: 'error' },
      },
    });
    expect(decision.action).toBe('escalate');
    expect(decision.request).toBe('inspect');
  });

  it('prefers the most conservative action when several metrics fail', () => {
    const decision = decide({
      evidence: {
        failingSlos: ['tool_error_rate', 'confabulation_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: {
          tool_error_rate: 'error',
          confabulation_rate: 'error',
        },
      },
    });
    expect(decision.action).toBe('escalate');
    expect(decision.slo).toBe('confabulation_rate');
  });

  it('falls back to escalation when the action is not permitted', () => {
    const decision = decide({
      policy: { ...POLICY, allowed: ['escalate'] },
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('escalate');
    expect(decision.reason).toContain('not permitted');
  });

  it('stays silent when neither the action nor escalation is permitted', () => {
    const decision = decide({
      policy: { ...POLICY, allowed: [] },
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('none');
  });

  it('does not repeat the same action inside the cooldown', () => {
    const decision = decide({
      lastAction: { action: 'degrade-mode', slo: 'tool_error_rate', atMs: NOW - 60 * 1000 },
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('none');
    expect(decision.reason).toContain('cooldown');
  });

  it('acts again once the cooldown has passed', () => {
    const decision = decide({
      lastAction: {
        action: 'degrade-mode',
        slo: 'tool_error_rate',
        atMs: NOW - 7 * 60 * 60 * 1000,
      },
      evidence: {
        failingSlos: ['tool_error_rate'],
        unavailableSlos: [],
        evidenceAgeMs: 1000,
        activityStatusBySlo: { tool_error_rate: 'error' },
      },
    });
    expect(decision.action).toBe('degrade-mode');
  });
});

describe('the homeostat policy', () => {
  it('allows shedding load and escalating, and nothing else', () => {
    const policy = readHomeostatPolicy({} as NodeJS.ProcessEnv);
    expect(policy.allowed).toEqual(['degrade-mode', 'escalate']);
    expect(policy.allowed).not.toContain('repair');
    expect(policy.allowed).not.toContain('restart');
  });

  it('reads the actions, the evidence bound and the cooldown from the environment', () => {
    const policy = readHomeostatPolicy({
      MEMPHIS_HOMEOSTAT_ACTIONS: 'escalate',
      MEMPHIS_HOMEOSTAT_MAX_EVIDENCE_AGE_MS: '900000',
      MEMPHIS_HOMEOSTAT_COOLDOWN_MS: '120000',
    } as NodeJS.ProcessEnv);
    expect(policy.allowed).toEqual(['escalate']);
    expect(policy.maxEvidenceAgeMs).toBe(900000);
    expect(policy.cooldownMs).toBe(120000);
  });

  it('ignores an action it does not know', () => {
    const policy = readHomeostatPolicy({
      MEMPHIS_HOMEOSTAT_ACTIONS: 'escalate,self-destruct',
    } as NodeJS.ProcessEnv);
    expect(policy.allowed).toEqual(['escalate']);
  });

  it('keeps the default when the number in the environment is nonsense', () => {
    const policy = readHomeostatPolicy({
      MEMPHIS_HOMEOSTAT_MAX_EVIDENCE_AGE_MS: 'not-a-number',
    } as NodeJS.ProcessEnv);
    expect(policy.maxEvidenceAgeMs).toBe(60 * 60 * 1000);
  });
});

describe('the homeostat reads the current state of the failing metric', () => {
  it('reads the status of the metric own class', () => {
    const statuses = homeostatActivityStatus(['tool_error_rate', 'provider_error_rate'], {
      turn: { status: 'ok' },
      provider: { status: 'error' },
      tool: { status: 'error' },
    });
    expect(statuses.tool_error_rate).toBe('error');
    expect(statuses.provider_error_rate).toBe('error');
  });

  it('treats a class that never produced a span as unknown, not as an error', () => {
    const statuses = homeostatActivityStatus(['tool_error_rate'], {
      turn: { status: 'ok' },
      provider: null,
      tool: null,
    });
    expect(statuses.tool_error_rate).toBe('unknown');
  });

  it('treats a metric it cannot place as unknown', () => {
    const statuses = homeostatActivityStatus(['some_metric_from_the_future'], {
      turn: { status: 'error' },
    });
    expect(statuses.some_metric_from_the_future).toBe('unknown');
  });
});

describe('the homeostat runs its decision', () => {
  it('does not run a handler for a decision of none', async () => {
    const outcome = await runInformationalHomeostat(
      { action: 'none', reason: 'nothing to do' },
      { degradeMode: () => ({ ok: true }) },
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.action).toBe('none');
  });

  it('runs the shedding handler', async () => {
    let ran = false;
    const outcome = await runInformationalHomeostat(
      { action: 'degrade-mode', slo: 'tool_error_rate', reason: 'because' },
      {
        degradeMode: () => {
          ran = true;
          return { ok: true, detail: 'shed: builtin-operator-briefing' };
        },
      },
    );
    expect(ran).toBe(true);
    expect(outcome.executed).toBe(true);
    expect(outcome.detail).toContain('builtin-operator-briefing');
  });

  it('reports a handler that throws as an outcome, not as a crash', async () => {
    const outcome = await runInformationalHomeostat(
      { action: 'degrade-mode', reason: 'because' },
      {
        degradeMode: () => {
          throw new Error('the task store is locked');
        },
      },
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.error).toContain('the task store is locked');
  });

  it('reports a missing handler instead of pretending it worked', async () => {
    const outcome = await runInformationalHomeostat(
      { action: 'degrade-mode', reason: 'because' },
      {},
    );
    expect(outcome.executed).toBe(false);
    expect(outcome.error).toContain('no handler');
  });
});

describe('the homeostat names what the operator is asked to do', () => {
  it('names each request', () => {
    expect(describeHomeostatRequest('repair')).toContain('memphis repair runtime');
    expect(describeHomeostatRequest('restart')).toContain('tier-3');
    expect(describeHomeostatRequest('inspect')).toContain('inspect');
    expect(describeHomeostatRequest('shed-load')).toContain('shed');
  });
});

describe('the tasks the homeostat may shed', () => {
  it('never includes the watch itself or the scheduled backup', () => {
    expect(HOMEIOSTAT_DEGRADABLE_TASK_IDS).not.toContain('builtin-runtime-watch');
    expect(HOMEIOSTAT_DEGRADABLE_TASK_IDS).not.toContain('builtin-scheduled-backup');
  });
});
