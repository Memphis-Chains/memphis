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

  it('surfaces the embed backend label in the latency check detail (S4-2)', async () => {
    // Issue from operator's box on 2026-04-30: embed search took 1473ms
    // (vs <10ms target) and the doctor warning gave no signal whether
    // that was a slow local index or remote-provider RTT. The detail
    // now names the backend so the warn maps to a clear cause.
    process.env.RUST_EMBED_MODE = 'ollama';
    process.env.RUST_EMBED_PROVIDER_URL = 'http://127.0.0.1:11434';
    process.env.RUST_EMBED_PROVIDER_MODEL = 'nomic-embed-text';
    try {
      const report = await runDoctorChecksV2();
      const embedCheck = report.checks.find((c) => c.id === 't3-embed-search-latency');
      expect(embedCheck).toBeDefined();
      // Detail always names the backend, regardless of latency outcome.
      expect(embedCheck?.detail).toMatch(/backend=ollama\/nomic-embed-text/);
      expect(embedCheck?.detail).toContain('http://127.0.0.1:11434');
    } finally {
      delete process.env.RUST_EMBED_MODE;
      delete process.env.RUST_EMBED_PROVIDER_URL;
      delete process.env.RUST_EMBED_PROVIDER_MODEL;
    }
  });

  it('labels backend as local-deterministic by default (no env)', async () => {
    delete process.env.RUST_EMBED_MODE;
    const report = await runDoctorChecksV2();
    const embedCheck = report.checks.find((c) => c.id === 't3-embed-search-latency');
    expect(embedCheck?.detail).toContain('backend=local-deterministic');
  });

  it('normalizes RUST_EMBED_MODE case to match Rust adapter (Codex P2 round 5)', async () => {
    // Rust adapter does to_ascii_lowercase() on the env var. TS used
    // raw comparison and would mislabel RUST_EMBED_MODE=LOCAL as
    // remote, emitting the wrong fix string.
    process.env.RUST_EMBED_MODE = 'LOCAL';
    try {
      const report = await runDoctorChecksV2();
      const embedCheck = report.checks.find((c) => c.id === 't3-embed-search-latency');
      expect(embedCheck?.detail).toContain('backend=local-deterministic');
    } finally {
      delete process.env.RUST_EMBED_MODE;
    }
  });

  it('classifies unknown RUST_EMBED_MODE as local fallback (Codex P2 round 6)', async () => {
    // Rust adapter (config.rs:embed_mode_from_env) silently falls back
    // to LocalDeterministic for any value outside its match arms. TS
    // used to label the typo as a remote backend ('cascad/...') and
    // emit the wrong fix string. Make sure unknown modes resolve to
    // local-deterministic with a hint that the input was unrecognized.
    process.env.RUST_EMBED_MODE = 'cascad';
    process.env.RUST_EMBED_PROVIDER_MODEL = 'nomic-embed-text';
    try {
      const report = await runDoctorChecksV2();
      const embedCheck = report.checks.find((c) => c.id === 't3-embed-search-latency');
      expect(embedCheck?.detail).toContain('backend=local-deterministic');
      expect(embedCheck?.detail).toContain("unknown mode 'cascad'");
    } finally {
      delete process.env.RUST_EMBED_MODE;
      delete process.env.RUST_EMBED_PROVIDER_MODEL;
    }
  });

  it('redacts userinfo and query string from RUST_EMBED_PROVIDER_URL (Codex P2 round 5)', async () => {
    process.env.RUST_EMBED_MODE = 'ollama';
    process.env.RUST_EMBED_PROVIDER_URL = 'https://user:secret@embed.example.com:8080/api?api_key=ABC123';
    process.env.RUST_EMBED_PROVIDER_MODEL = 'nomic-embed-text';
    try {
      const report = await runDoctorChecksV2();
      const embedCheck = report.checks.find((c) => c.id === 't3-embed-search-latency');
      // userinfo stripped, query string dropped
      expect(embedCheck?.detail).not.toContain('user:secret');
      expect(embedCheck?.detail).not.toContain('api_key=ABC123');
      expect(embedCheck?.detail).not.toContain('ABC123');
      // host + scheme + path preserved for diagnostic value
      expect(embedCheck?.detail).toContain('https://embed.example.com:8080/api');
    } finally {
      delete process.env.RUST_EMBED_MODE;
      delete process.env.RUST_EMBED_PROVIDER_URL;
      delete process.env.RUST_EMBED_PROVIDER_MODEL;
    }
  });
});
