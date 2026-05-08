/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
/**
 * `memphis tier` — inspect, elevate, and revoke tier-3 sessions across
 * surfaces (TUI/Telegram/Matrix/HTTP/CLI).
 *
 * Tier-3 sessions live in the daemon's in-process Map
 * (`src/security/tier3-session.ts:39 sessions`). The CLI is a separate
 * node process from `memphis serve`, so it queries HTTP endpoints under
 * `/v1/ops/tier3/*` instead of touching the Map directly.
 *
 * Subcommands:
 *   memphis tier                              # alias for status
 *   memphis tier status                       # human format
 *   memphis tier status --json                # JSON format
 *   memphis tier elevate                      # interactive — prompts for passphrase
 *   memphis tier elevate --actor <id>         # explicit actor id
 *   memphis tier revoke                       # revoke all
 *   memphis tier revoke --surface <s> --actor <id>  # revoke specific
 */

import { emitKeypressEvents } from 'node:readline';

import type { CommandHandler } from './command-handler.js';
import type { CliContext } from '../context.js';

interface Tier3SessionSnapshot {
  surface: string;
  actorId: string;
  grantedAt: string;
  expiresAt: string;
  remainingMs: number;
}

interface Tier3SessionsResponse {
  ok: boolean;
  count: number;
  sessions: Tier3SessionSnapshot[];
  asOf: string;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function renderHuman(payload: Tier3SessionsResponse): string {
  const lines: string[] = [];
  lines.push(`Tier-3 sessions: ${payload.count} active`);
  for (const s of payload.sessions) {
    lines.push(`  [${s.surface}:${s.actorId}]`);
    lines.push(`    granted:    ${s.grantedAt}`);
    lines.push(`    expires:    ${s.expiresAt} (in ${formatRemaining(s.remainingMs)})`);
    lines.push(`    surface:    ${s.surface}`);
    lines.push(`    actorId:    ${s.actorId}`);
  }
  if (payload.count === 0) {
    lines.push('  (no active sessions — use TUI or Telegram /tier 3 <pass> to elevate)');
  }
  return lines.join('\n');
}

async function handleTierStatus(context: CliContext): Promise<boolean> {
  const config = context.getConfig();
  const url = `http://${config.HOST}:${config.PORT}/v1/ops/tier3/sessions`;
  const token = config.MEMPHIS_API_TOKEN;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ECONNREFUSED' || (error as Error)?.message?.includes('ECONNREFUSED')) {
      console.error(
        'Tier-3 status unavailable — Memphis daemon is not running.\n' +
          'Start it with: systemctl --user start memphis (or: memphis serve)',
      );
      return true;
    }
    console.error(
      `Failed to reach daemon at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }

  if (response.status === 401 || response.status === 403) {
    console.error(
      `Unauthorized (${response.status}) — check MEMPHIS_API_TOKEN matches the daemon value.\n` +
        'The token is read from .env at the install root; the daemon reads the same file.',
    );
    return true;
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* swallow */
    }
    console.error(`Daemon returned ${response.status}: ${body || '(empty body)'}`);
    return true;
  }

  let payload: Tier3SessionsResponse;
  try {
    payload = (await response.json()) as Tier3SessionsResponse;
  } catch (error) {
    console.error(
      `Daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return true;
  }

  if (context.args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(renderHuman(payload));
  }
  return true;
}

/**
 * Read a passphrase from a TTY without echoing characters. Falls back to
 * the operator-supplied env var `MEMPHIS_OPERATOR_PASSPHRASE` for non-TTY
 * (CI / scripted) runs. Mirrors the pattern in `vault.handler.ts`.
 *
 * NEVER accept the passphrase as a CLI flag — operator memory rule
 * (`feedback_interactive_secret_input`): "operator refuses to type secrets
 * as CLI flags; prompt via hidden TTY when flags absent."
 */
function parseFlag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  // Reject the next token if it's another flag (`--surface --actor 123`
  // would otherwise bind `--actor` as the surface value).
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

async function promptHiddenPassphrase(label: string): Promise<string> {
  const envPass = process.env.MEMPHIS_OPERATOR_PASSPHRASE?.trim();
  if (envPass) return envPass;

  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY) {
    throw new Error(
      `${label}: stdin is not a TTY. Set MEMPHIS_OPERATOR_PASSPHRASE in env for non-interactive runs.`,
    );
  }
  return new Promise<string>((resolvePromise, rejectPromise) => {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(`${label}: `);
    let value = '';
    const handler = (
      _ch: string | undefined,
      key: { ctrl?: boolean; name?: string; sequence?: string },
    ): void => {
      if (key.ctrl && key.name === 'c') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('keypress', handler);
        stdout.write('\n');
        rejectPromise(new Error('cancelled'));
        return;
      }
      if (key.name === 'return' || key.name === 'enter') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('keypress', handler);
        stdout.write('\n');
        resolvePromise(value);
        return;
      }
      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          stdout.write('\b \b');
        }
        return;
      }
      if (key.sequence && key.sequence.length === 1) {
        const code = key.sequence.charCodeAt(0);
        if (code >= 32 && code !== 127) {
          value += key.sequence;
          stdout.write('*');
        }
      }
    };
    stdin.on('keypress', handler);
  });
}

async function handleTierElevate(context: CliContext): Promise<boolean> {
  const config = context.getConfig();
  const url = `http://${config.HOST}:${config.PORT}/v1/ops/tier3/elevate`;
  const token = config.MEMPHIS_API_TOKEN;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const surface = parseFlag(context.argv, '--surface') ?? 'cli';
  const actorId =
    parseFlag(context.argv, '--actor') ??
    parseFlag(context.argv, '--actorId') ??
    process.env.USER ??
    'cli-operator';

  let passphrase: string;
  try {
    passphrase = await promptHiddenPassphrase('Operator passphrase');
  } catch (error) {
    console.error(
      `Tier-3 elevate cancelled: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return true;
  }
  if (passphrase.length < 8) {
    console.error('Operator passphrase must be at least 8 characters.');
    process.exitCode = 1;
    return true;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ surface, actorId, passphrase }),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ECONNREFUSED' || (error as Error)?.message?.includes('ECONNREFUSED')) {
      console.error(
        'Tier-3 elevate unavailable — Memphis daemon is not running.\n' +
          'Start it with: systemctl --user start memphis (or: memphis serve)',
      );
      process.exitCode = 1;
      return true;
    }
    console.error(
      `Failed to reach daemon at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return true;
  }

  if (response.status === 401 || response.status === 403) {
    let body: { ok?: boolean; reason?: string; error?: string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      /* swallow */
    }
    if (response.status === 401) {
      console.error(
        `Unauthorized (401) — check MEMPHIS_API_TOKEN matches the daemon value.`,
      );
    } else {
      console.error(`Tier-3 denied (${body.reason ?? 'forbidden'}): ${body.error ?? '(unknown)'}`);
    }
    process.exitCode = 1;
    return true;
  }

  let payload: {
    ok: boolean;
    tier?: number;
    session?: { surface: string; actorId: string; grantedAt: string; expiresAt: string };
    error?: string;
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    console.error(
      `Daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return true;
  }

  if (!response.ok || !payload.ok) {
    console.error(`Daemon returned ${response.status}: ${payload.error ?? '(unknown error)'}`);
    process.exitCode = 1;
    return true;
  }

  if (context.args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    const session = payload.session!;
    console.log(`Tier 3 granted for surface=${session.surface} actor=${session.actorId}.`);
    console.log(`Expires at: ${session.expiresAt}`);
  }
  return true;
}

async function handleTierCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;
  if (sub === 'status' || !sub) {
    return handleTierStatus(context);
  }
  if (sub === 'elevate') {
    return handleTierElevate(context);
  }
  console.error(`Unknown tier subcommand: ${sub}`);
  console.error('Usage: memphis tier <status|elevate>');
  return true;
}

export const tierCommandHandler: CommandHandler = {
  name: 'tier',
  commands: ['tier'],
  canHandle: (context: CliContext) => context.args.command === 'tier',
  handle: handleTierCommand,
};
