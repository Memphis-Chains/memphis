/**
 * Sprint H PR-C — voice status CLI contract.
 *
 * Pin the `memphis voice status` shape:
 *  - Cloud route reports engine names, no network round-trip
 *  - Local route hits both checkWhisper + checkPiper, surfaces error
 *    envelopes when servers are unreachable
 *  - Disabled (cloud + no token) returns notes pointing at remediation
 *  - --json emits structured JSON; default emits human-readable lines
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Module mocks are scoped to this file via vi.doMock + dynamic import, so
// they don't leak into doctor-v2.test.ts when the runner happens to reuse
// the same worker pool. The earlier static `vi.mock(...)` form hoisted
// module-level mocks that survived past the file's last `it()` and
// poisoned doctor-v2's voice-stack check.
vi.doMock('../../src/gateway/voice/local-piper-adapter.js', () => ({
  textToSpeechLocal: vi.fn(),
  checkPiperServerHealth: vi.fn(async () => ({ ok: true, latencyMs: 12 })),
}));
vi.doMock('../../src/gateway/voice/local-whisper-adapter.js', () => ({
  speechToTextLocal: vi.fn(),
  checkWhisperServerHealth: vi.fn(async () => ({ ok: true, latencyMs: 8 })),
}));

// Lazy module references resolved once after vi.doMock above is in
// effect. Static top-level imports would bypass doMock on some
// module-resolution orderings.
let checkPiperServerHealth: ReturnType<typeof vi.fn>;
let checkWhisperServerHealth: ReturnType<typeof vi.fn>;
let voiceCommandHandler: { handle: (ctx: unknown) => Promise<boolean> };

function buildContext(
  args: Record<string, unknown>,
  argv: string[] = [],
): { argv: string[]; args: Record<string, unknown> } {
  return {
    argv,
    args: { command: 'voice', subcommand: 'status', json: false, ...args },
  };
}

describe('voice command handler — `memphis voice status`', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let captured = '';
  let capturedErr = '';
  const savedEnv = { ...process.env };

  // Resolve the handler + mocked health probes after vi.doMock has
  // committed. vitest doMock is scoped to this module's import graph.
  beforeEach(async () => {
    const piper = await import('../../src/gateway/voice/local-piper-adapter.js');
    const whisper = await import('../../src/gateway/voice/local-whisper-adapter.js');
    const handler = await import('../../src/infra/cli/handlers/voice.handler.js');
    checkPiperServerHealth = piper.checkPiperServerHealth as unknown as ReturnType<typeof vi.fn>;
    checkWhisperServerHealth = whisper.checkWhisperServerHealth as unknown as ReturnType<
      typeof vi.fn
    >;
    voiceCommandHandler = handler.voiceCommandHandler as unknown as {
      handle: (ctx: unknown) => Promise<boolean>;
    };
  });

  afterAll(() => {
    vi.doUnmock('../../src/gateway/voice/local-piper-adapter.js');
    vi.doUnmock('../../src/gateway/voice/local-whisper-adapter.js');
  });

  beforeEach(() => {
    captured = '';
    capturedErr = '';
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((data: string | Uint8Array) => {
        captured += String(data);
        return true;
      }) as never);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(((data: string | Uint8Array) => {
        capturedErr += String(data);
        return true;
      }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    vi.clearAllMocks();
  });

  it('local mode + healthy servers → ok=true, both engines reachable', async () => {
    process.env.MEMPHIS_VOICE_MODE = 'local';
    delete process.env.HUGGINGFACE_API_TOKEN;
    const ok = await voiceCommandHandler.handle(
      buildContext({ json: true }) as never,
    );
    expect(ok).toBe(true);
    const report = JSON.parse(captured);
    expect(report.ok).toBe(true);
    expect(report.resolvedRoute).toBe('local');
    expect(report.stt.reachable).toBe(true);
    expect(report.tts.reachable).toBe(true);
    expect(checkWhisperServerHealth).toHaveBeenCalledTimes(1);
    expect(checkPiperServerHealth).toHaveBeenCalledTimes(1);
  });

  it('local mode + unreachable STT → ok=false, surfaces error', async () => {
    vi.mocked(checkWhisperServerHealth).mockResolvedValueOnce({
      ok: false,
      error: 'ECONNREFUSED',
    });
    process.env.MEMPHIS_VOICE_MODE = 'local';
    delete process.env.HUGGINGFACE_API_TOKEN;
    await voiceCommandHandler.handle(buildContext({ json: true }) as never);
    const report = JSON.parse(captured);
    expect(report.ok).toBe(false);
    expect(report.stt.reachable).toBe(false);
    expect(report.stt.error).toContain('ECONNREFUSED');
  });

  it('cloud mode + HF token → reports cloud engines, no network probes', async () => {
    process.env.MEMPHIS_VOICE_MODE = 'cloud';
    process.env.HUGGINGFACE_API_TOKEN = 'hf_xxx';
    await voiceCommandHandler.handle(buildContext({ json: true }) as never);
    const report = JSON.parse(captured);
    expect(report.resolvedRoute).toBe('cloud');
    expect(report.stt.engine).toContain('HuggingFace');
    expect(checkWhisperServerHealth).not.toHaveBeenCalled();
    expect(checkPiperServerHealth).not.toHaveBeenCalled();
  });

  it('cloud mode + no HF token → disabled, with remediation notes', async () => {
    process.env.MEMPHIS_VOICE_MODE = 'cloud';
    delete process.env.HUGGINGFACE_API_TOKEN;
    await voiceCommandHandler.handle(buildContext({ json: true }) as never);
    const report = JSON.parse(captured);
    expect(report.ok).toBe(false);
    expect(report.resolvedRoute).toBe('disabled');
    expect(report.notes.join(' ')).toMatch(/MEMPHIS_VOICE_MODE=local/);
  });

  it('default human format includes engine + reachability lines', async () => {
    process.env.MEMPHIS_VOICE_MODE = 'local';
    delete process.env.HUGGINGFACE_API_TOKEN;
    await voiceCommandHandler.handle(buildContext({ json: false }) as never);
    expect(captured).toMatch(/Voice stack: . ready/);
    expect(captured).toContain('STT  engine:');
    expect(captured).toContain('TTS  engine:');
    expect(captured).toMatch(/reachable: yes/);
  });

  it('unknown subcommand returns true (handled) + writes usage to stderr + sets exitCode', async () => {
    // Codex P2 #433: returning `false` here made the dispatcher fall
    // through to "Unknown command: voice", duplicating the error path.
    // Other namespace handlers (auth, config, vault) all return true
    // after writing usage and let the non-zero exit code carry the
    // "this command failed" signal.
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    const ok = await voiceCommandHandler.handle(
      buildContext({ subcommand: 'bogus' }) as never,
    );
    expect(ok).toBe(true);
    expect(capturedErr).toContain('Usage:');
    expect(process.exitCode).toBe(2);
    process.exitCode = previousExitCode;
  });
});
