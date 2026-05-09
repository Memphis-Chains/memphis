import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDoctorChecksV2 } from '../../src/infra/cli/utils/doctor-v2.js';

// Closure sprint Z.2.1 (2026-05-09): the `ta12-voice-stack` doctor
// probe previously hard-failed whenever route resolved to `local` and
// Whisper/Piper engines were unreachable. Daily-use operators without
// the offline voice stack saw `ok: false` even though their workflow
// didn't need local voice. Now the failure-vs-warning is gated on
// `MEMPHIS_VOICE_ROUTE_REQUIRED=local`.
//
// These four cases pin the contract so the gate doesn't regress.

describe('doctor ta12-voice-stack — Z.2.1 fail-gate behind MEMPHIS_VOICE_ROUTE_REQUIRED', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Stub Whisper/Piper health checks to fail (the no-engines case).
    // Tests that need engines reachable override these.
    vi.doMock('../../src/gateway/voice/local-whisper-adapter.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/gateway/voice/local-whisper-adapter.js')>(
        '../../src/gateway/voice/local-whisper-adapter.js',
      );
      return {
        ...actual,
        checkWhisperServerHealth: vi.fn(async () => ({ ok: false, error: 'fetch failed' })),
      };
    });
    vi.doMock('../../src/gateway/voice/local-piper-adapter.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/gateway/voice/local-piper-adapter.js')>(
        '../../src/gateway/voice/local-piper-adapter.js',
      );
      return {
        ...actual,
        checkPiperServerHealth: vi.fn(async () => ({ ok: false, error: 'fetch failed' })),
      };
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('cloud route → pass (no engines probed)', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-voice-cloud-'));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
      MEMPHIS_VOICE_MODE: 'cloud',
      HUGGINGFACE_API_TOKEN: 'hf_test_token_present',
    };

    const report = await runDoctorChecksV2();
    const voiceCheck = report.checks.find((c) => c.id === 'ta12-voice-stack');
    expect(voiceCheck, 'ta12-voice-stack must be present').toBeDefined();
    expect(voiceCheck?.level).toBe('pass');
    expect(voiceCheck?.detail).toContain('route=cloud');
  });

  it('local route + engines unreachable + ROUTE_REQUIRED unset → WARN (Z.2.1 downgrade win)', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-voice-local-noreq-'));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
      MEMPHIS_VOICE_MODE: 'local',
    };
    delete process.env.MEMPHIS_VOICE_ROUTE_REQUIRED;

    const report = await runDoctorChecksV2();
    const voiceCheck = report.checks.find((c) => c.id === 'ta12-voice-stack');
    expect(voiceCheck, 'ta12-voice-stack must be present').toBeDefined();
    // The whole point of Z.2.1: this used to be 'fail', now warn.
    expect(voiceCheck?.level).toBe('warn');
    expect(voiceCheck?.fix).toContain('Daily-use warning');
    expect(voiceCheck?.fix).toContain('MEMPHIS_VOICE_ROUTE_REQUIRED=local to escalate');
  });

  it('local route + engines unreachable + ROUTE_REQUIRED=local → FAIL (operator-stated requirement honored)', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-voice-local-required-'));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
      MEMPHIS_VOICE_MODE: 'local',
      MEMPHIS_VOICE_ROUTE_REQUIRED: 'local',
    };

    const report = await runDoctorChecksV2();
    const voiceCheck = report.checks.find((c) => c.id === 'ta12-voice-stack');
    expect(voiceCheck, 'ta12-voice-stack must be present').toBeDefined();
    expect(voiceCheck?.level).toBe('fail');
    expect(voiceCheck?.detail).toContain('MEMPHIS_VOICE_ROUTE_REQUIRED=local');
    expect(voiceCheck?.fix).toContain('unset MEMPHIS_VOICE_ROUTE_REQUIRED');
  });

  it('cloud route + no HF token → warn (config is null, existing behavior unchanged)', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-doctor-voice-disabled-'));
    process.env = {
      ...originalEnv,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: memphisDir,
      RUST_CHAIN_ENABLED: 'false',
      MEMPHIS_VOICE_MODE: 'cloud',
    };
    delete process.env.HUGGINGFACE_API_TOKEN;
    delete process.env.MEMPHIS_VOICE_ROUTE_REQUIRED;

    const report = await runDoctorChecksV2();
    const voiceCheck = report.checks.find((c) => c.id === 'ta12-voice-stack');
    expect(voiceCheck, 'ta12-voice-stack must be present').toBeDefined();
    expect(voiceCheck?.level).toBe('warn');
    expect(voiceCheck?.detail).toContain('disabled');
  });
});
