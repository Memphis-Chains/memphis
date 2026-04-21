import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { printDoctorHumanV2, runDoctorChecksV2 } from '../src/infra/cli/utils/doctor-v2.js';

let savedAutonomyMode: string | undefined;

beforeEach(() => {
  savedAutonomyMode = process.env.MEMPHIS_AUTONOMY_MODE;
  delete process.env.MEMPHIS_AUTONOMY_MODE;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS;
  delete process.env.MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER;
  delete process.env.MEMPHIS_SURFACE_TELEGRAM_ALLOW_URL_FETCH;
  if (savedAutonomyMode !== undefined) {
    process.env.MEMPHIS_AUTONOMY_MODE = savedAutonomyMode;
  }
});

describe('doctor v2', () => {
  it('returns comprehensive report with 25+ checks and all 7 tiers (1-6 plus A)', async () => {
    const report = await runDoctorChecksV2();

    expect(report.checks.length).toBeGreaterThanOrEqual(25);
    const tiers = new Set(report.checks.map((c) => c.tier));
    expect(tiers).toEqual(new Set([1, 2, 3, 4, 5, 6, 'A']));

    expect(report.summary.total).toBe(report.checks.length);
    expect(report).toHaveProperty('ok');
  });

  it('supports deep scan mode by adding deep checks', { timeout: 30_000 }, async () => {
    const base = await runDoctorChecksV2();
    const deep = await runDoctorChecksV2({ deep: true });

    expect(deep.checks.length).toBeGreaterThan(base.checks.length);
    expect(deep.checks.some((c) => c.id === 't6-deep-shell')).toBe(true);
  });

  it('prints ascii-box human summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const report = await runDoctorChecksV2();

    printDoctorHumanV2(report);

    const output = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('MEMPHIS DOCTOR v2.0');
    expect(output).toContain('Tier 1: Core Infrastructure');
    expect(output).toContain('Summary: total=');
  });

  it('header PASS/FAIL tracks report.ok, not summary.fail', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Build a fixture with a required-warn that flips report.ok=false
    // while summary.fail stays 0 — the exact divergence Codex flagged.
    const report = {
      ok: false,
      checks: [
        {
          id: 'required-warn',
          tier: 1,
          title: 'Required warn case',
          level: 'warn',
          detail: 'missing DID',
          required: true,
        },
      ],
      summary: { total: 1, pass: 0, warn: 1, fail: 0, required: 1, requiredFailures: 1 },
      repair: { ok: true, status: 'healthy', recommendedAction: 'none', applied: [], warnings: [] },
      repairStatus: 'healthy',
      repairable: false,
      recommendedAction: 'none',
      repairs: [],
      firstRunPlan: { summary: 'initialized', nextCommand: 'none' },
    } as unknown as Parameters<typeof printDoctorHumanV2>[0];

    printDoctorHumanV2(report);

    const output = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('MEMPHIS DOCTOR v2.0 FAIL');
    expect(output).not.toContain('MEMPHIS DOCTOR v2.0 PASS');
  });

  it('legacy exports remain compatible', async () => {
    const doctor = await import('../src/infra/cli/utils/doctor.js');
    const report = await doctor.runDoctorChecks();
    expect(report.checks.length).toBeGreaterThanOrEqual(25);
  });

  it('flags dangerous chat-surface overrides as a security failure', async () => {
    process.env.MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS = 'true';
    process.env.MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER = '2';
    process.env.MEMPHIS_AUTONOMY_MODE = 'balanced';

    const report = await runDoctorChecksV2();
    const hardening = report.checks.find((check) => check.id === 't4-chat-surface-hardening');

    expect(hardening).toMatchObject({
      level: 'fail',
      ok: false,
      required: true,
    });
    expect(hardening?.detail).toContain('telegram');
    expect(hardening?.detail).toContain('unknown tools allowed');
  });

  it('downgrades surface hardening to warn in full autonomy mode', async () => {
    process.env.MEMPHIS_SURFACE_TELEGRAM_ALLOW_UNKNOWN_TOOLS = 'true';
    process.env.MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER = '2';
    process.env.MEMPHIS_AUTONOMY_MODE = 'full';

    const report = await runDoctorChecksV2();
    const hardening = report.checks.find((check) => check.id === 't4-chat-surface-hardening');

    expect(hardening).toMatchObject({
      level: 'warn',
      ok: true,
      required: false,
    });
    expect(hardening?.detail).toContain('[full autonomy]');
  });
});
