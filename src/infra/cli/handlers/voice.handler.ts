/**
 * `memphis voice` — inspect the operator's voice stack (cloud vs
 * local routing, STT engine, TTS engine, server reachability) and
 * one-shot install the local stack.
 *
 * Sprint H PR-C • 2026-05-04 • depends on PR-A chooser + PR-B Piper
 * adapter. Live demo prep: operator runs `memphis voice install` on a
 * fresh box, then `memphis voice status` to confirm both engines are
 * reachable and routed correctly.
 *
 * Subcommands:
 *   memphis voice                         # alias for status
 *   memphis voice status                  # human format
 *   memphis voice status --json           # JSON format for scripting
 *   memphis voice install                 # idempotent local-stack installer
 *   memphis voice install --restart       # (re)start servers without re-installing
 *   memphis voice install --stop          # stop running servers
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MEMPHIS_VOICE_MODE,
  PIPER_SERVER_URL,
  WHISPER_SERVER_URL,
} from '../../../config/env-registry.js';
import { checkPiperServerHealth } from '../../../gateway/voice/local-piper-adapter.js';
import { checkWhisperServerHealth } from '../../../gateway/voice/local-whisper-adapter.js';
import { resolveVoiceConfig } from '../../../gateway/voice/voice-service.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

interface VoiceStatusReport {
  ok: boolean;
  rawMode: string;
  resolvedRoute: 'cloud' | 'local' | 'disabled';
  stt: {
    engine: string;
    model?: string;
    serverUrl?: string;
    reachable?: boolean;
    latencyMs?: number;
    error?: string;
  };
  tts: {
    engine: string;
    model?: string;
    serverUrl?: string;
    reachable?: boolean;
    latencyMs?: number;
    error?: string;
  };
  notes: string[];
}

async function buildStatusReport(rawEnv: NodeJS.ProcessEnv): Promise<VoiceStatusReport> {
  const config = resolveVoiceConfig(rawEnv);
  const rawMode = MEMPHIS_VOICE_MODE.read(rawEnv);

  if (!config) {
    return {
      ok: false,
      rawMode,
      resolvedRoute: 'disabled',
      stt: { engine: 'none' },
      tts: { engine: 'none' },
      notes: [
        'Voice disabled — MEMPHIS_VOICE_MODE=cloud was set but no HUGGINGFACE_API_TOKEN configured.',
        'Run `memphis vault get huggingface_api_token` to verify, or switch to MEMPHIS_VOICE_MODE=local.',
      ],
    };
  }

  const notes: string[] = [];
  if (config.rawMode === 'auto') {
    notes.push(
      `auto-resolved to ${config.route} (${config.route === 'cloud' ? 'HF token present' : 'HF token absent'})`,
    );
  }

  if (config.route === 'local') {
    const [sttHealth, ttsHealth] = await Promise.all([
      checkWhisperServerHealth(),
      checkPiperServerHealth(),
    ]);
    return {
      ok: sttHealth.ok && ttsHealth.ok,
      rawMode,
      resolvedRoute: 'local',
      stt: {
        engine: 'faster-whisper / whisper.cpp (local)',
        serverUrl: WHISPER_SERVER_URL.read(rawEnv),
        reachable: sttHealth.ok,
        latencyMs: sttHealth.latencyMs,
        error: sttHealth.error,
      },
      tts: {
        engine: 'Piper (local)',
        serverUrl: PIPER_SERVER_URL.read(rawEnv),
        reachable: ttsHealth.ok,
        latencyMs: ttsHealth.latencyMs,
        error: ttsHealth.error,
      },
      notes,
    };
  }

  // route === 'cloud'
  return {
    ok: true,
    rawMode,
    resolvedRoute: 'cloud',
    stt: {
      engine: 'HuggingFace Whisper (cloud)',
      model: config.sttModel,
    },
    tts: {
      engine:
        config.ttsProvider === 'google' && config.googleTtsApiKey
          ? 'Google Cloud TTS (cloud)'
          : 'HuggingFace MMS-TTS (cloud)',
      model: config.ttsModel,
    },
    notes,
  };
}

function formatHuman(report: VoiceStatusReport): string {
  const lines: string[] = [];
  lines.push(
    `Voice stack: ${report.ok ? '✓ ready' : '✗ degraded'} (mode=${report.rawMode}, route=${report.resolvedRoute})`,
  );
  lines.push('');
  lines.push(`STT  engine: ${report.stt.engine}`);
  if (report.stt.serverUrl) lines.push(`     server: ${report.stt.serverUrl}`);
  if (report.stt.model) lines.push(`     model:  ${report.stt.model}`);
  if (report.stt.reachable !== undefined) {
    lines.push(
      `     reachable: ${report.stt.reachable ? `yes (${report.stt.latencyMs ?? '?'}ms)` : `no — ${report.stt.error ?? 'no error message'}`}`,
    );
  }
  lines.push('');
  lines.push(`TTS  engine: ${report.tts.engine}`);
  if (report.tts.serverUrl) lines.push(`     server: ${report.tts.serverUrl}`);
  if (report.tts.model) lines.push(`     model:  ${report.tts.model}`);
  if (report.tts.reachable !== undefined) {
    lines.push(
      `     reachable: ${report.tts.reachable ? `yes (${report.tts.latencyMs ?? '?'}ms)` : `no — ${report.tts.error ?? 'no error message'}`}`,
    );
  }
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('notes:');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}

function resolveInstallScript(): string | undefined {
  // Walk up from this file to the repo root and look for scripts/voice-install.sh.
  // Works for source-tree runs (src/infra/cli/handlers/) and for built
  // dist trees (dist/src/infra/cli/handlers/) — both land at <repo>/scripts/.
  const here = dirname(fileURLToPath(import.meta.url));
  for (let dir = here, prev = ''; dir !== prev; prev = dir, dir = dirname(dir)) {
    const candidate = resolve(dir, 'scripts', 'voice-install.sh');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

// Mirror of scripts/voice-install.sh KNOWN_VOICES catalog. Keep in sync
// when adding voices: the bash side is the source of truth, but we
// validate here so the CLI rejects bogus voices before launching bash
// (cleaner error UX, plus prevents shell-side surprises).
const KNOWN_VOICES = new Set(['gosia', 'darkman']);

export function buildInstallerPassthrough(argv: readonly string[]): string[] {
  const out: string[] = [];
  if (argv.includes('--restart')) out.push('--restart');
  if (argv.includes('--stop')) out.push('--stop');
  // Voice flag — accept --voice <name> and --voice=<name>.
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    let value: string | undefined;
    if (tok === '--voice') value = argv[i + 1];
    else if (tok.startsWith('--voice=')) value = tok.slice('--voice='.length);
    if (value === undefined) continue;
    if (!KNOWN_VOICES.has(value)) {
      process.stderr.write(
        `memphis voice install: unknown voice "${value}". Known: ${[...KNOWN_VOICES].join(', ')}\n`,
      );
      // Sentinel — caller will surface exit code 1 without running installer.
      return ['__INVALID_VOICE__'];
    }
    out.push('--voice', value);
    break; // first --voice wins
  }
  return out;
}

async function runInstaller(passthrough: string[]): Promise<number> {
  if (passthrough[0] === '__INVALID_VOICE__') return 1;
  const script = resolveInstallScript();
  if (!script) {
    process.stderr.write(
      'memphis voice install: scripts/voice-install.sh not found in repo tree.\n' +
        '  This usually means you are running a packaged build that omits dev scripts.\n' +
        '  Run from a source checkout: `bash scripts/voice-install.sh`.\n',
    );
    return 2;
  }
  const args = [script, ...passthrough];
  return new Promise<number>((res) => {
    const child = spawn('bash', args, { stdio: 'inherit', env: process.env });
    child.on('error', (err) => {
      process.stderr.write(`memphis voice install: failed to launch bash: ${err.message}\n`);
      res(2);
    });
    child.on('exit', (code) => res(code ?? 1));
  });
}

async function handleVoiceCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand ?? 'status';

  if (sub === 'install') {
    // Allowlisted argv passthrough — anything not in this set is
    // dropped before reaching the shell, so `memphis voice install
    // --rm -rf /` cannot smuggle args into the installer.
    //   --restart            (mode switch)
    //   --stop               (mode switch)
    //   --voice <name>       (downloads catalog + sets default)
    //   --voice=<name>
    const passthrough = buildInstallerPassthrough(context.argv);
    process.exitCode = await runInstaller(passthrough);
    return true;
  }

  if (sub !== 'status') {
    // Return `true` (handled) so the dispatcher doesn't fall through
    // to "Unknown command: voice" — the error is the bad subcommand,
    // not the bad verb. Codex P2 #433 caught the duplicate-error UX
    // mismatch with other handlers (auth, config, vault) which all
    // return true after writing usage.
    process.stderr.write(
      `Unknown subcommand: voice ${sub}\n` +
        `Usage: memphis voice [status|install] [--json]\n`,
    );
    process.exitCode = 2;
    return true;
  }
  const report = await buildStatusReport(process.env);
  if (context.args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(report)}\n`);
  }
  return true;
}

export const voiceCommandHandler: CommandHandler = {
  name: 'voice',
  commands: ['voice'],
  canHandle: (context: CliContext) => context.args.command === 'voice',
  handle: handleVoiceCommand,
};
