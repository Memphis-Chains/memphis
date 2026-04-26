/**
 * `memphis tier` — read-only inspection of tier-3 elevation sessions.
 *
 * Tier-3 sessions live in the daemon's in-process Map
 * (`src/security/tier3-session.ts:39 sessions`). The CLI is a separate
 * node process from `memphis serve`, so it cannot read that Map directly.
 * This handler queries the new `GET /v1/ops/tier3/sessions` HTTP endpoint
 * and renders human or JSON output.
 *
 * Subcommands (forward-compat — only `status` today):
 *   memphis tier                 # alias for status
 *   memphis tier status          # human format
 *   memphis tier status --json   # JSON format
 *
 * Surfaced after a 2026-04-26 operator session where there was no way to
 * see "which surfaces have an active tier-3 session right now" without
 * digging through the audit chain.
 */

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

async function handleTierCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;
  if (sub === 'status' || !sub) {
    return handleTierStatus(context);
  }
  console.error(`Unknown tier subcommand: ${sub}`);
  console.error('Usage: memphis tier <status>');
  return true;
}

export const tierCommandHandler: CommandHandler = {
  name: 'tier',
  commands: ['tier'],
  canHandle: (context: CliContext) => context.args.command === 'tier',
  handle: handleTierCommand,
};
