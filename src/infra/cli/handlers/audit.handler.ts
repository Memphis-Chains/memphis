import {
  maybeRotateAuditLog,
  resolveAuditArchiveDir,
  resolveAuditLogPath,
} from '../../logging/audit-rotation.js';
import { searchAuditLog } from '../../logging/audit-search.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

function assertIsoLike(label: string, value: string | undefined): void {
  if (!value) return;
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(
      `audit search --${label}: expected an ISO-8601 timestamp (e.g. 2026-04-13T00:00:00Z), got "${value}"`,
    );
  }
}

function assertStatus(
  value: string | undefined,
): asserts value is undefined | 'allowed' | 'blocked' | 'error' {
  if (value === undefined) return;
  if (value !== 'allowed' && value !== 'blocked' && value !== 'error') {
    throw new Error(`audit search --status: expected one of allowed|blocked|error, got "${value}"`);
  }
}

export const auditCommandHandler: CommandHandler = {
  name: 'audit',
  commands: ['audit'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'audit';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    if (subcommand === 'search') {
      return handleAuditSearch(context);
    }
    if (subcommand === 'rotate') {
      return handleAuditRotate(context);
    }
    throw new Error(`Unknown audit subcommand: ${String(subcommand)}. Available: search, rotate.`);
  },
};

async function handleAuditRotate(context: CliContext): Promise<boolean> {
  // Wraps the existing rotation engine. Useful as an explicit operator
  // command — rotation otherwise only fires opportunistically when audit
  // writes cross the size threshold. Operators trigger this manually
  // before a backup, before a long offline period, or to trim before an
  // archive-retention policy needs the prior file out of the way.
  const result = maybeRotateAuditLog(process.env);
  print(
    {
      ok: true,
      rotated: result.rotated,
      archivePath: result.archivePath ?? null,
      bytesArchived: result.bytesArchived ?? 0,
      logPath: resolveAuditLogPath(process.env),
      archiveDir: resolveAuditArchiveDir(process.env),
    },
    context.args.json,
  );
  return true;
}

async function handleAuditSearch(context: CliContext): Promise<boolean> {
  const { json, since, until, action, status, contains, limit } = context.args;

  assertIsoLike('since', since);
  assertIsoLike('until', until);
  assertStatus(status);

  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
    throw new Error(`audit search --limit: expected a positive integer, got "${limit}"`);
  }

  const result = await searchAuditLog(
    {
      since,
      until,
      action,
      status,
      contains,
      limit,
    },
    process.env,
  );

  if (json) {
    print(
      {
        ok: true,
        matchCount: result.records.length,
        truncated: result.truncated,
        filesScanned: result.filesScanned,
        records: result.records.map((r) => ({
          ts: r.ts,
          action: r.action,
          status: r.status,
          ip: r.ip,
          route: r.route,
          details: r.details,
          source: r.source,
        })),
      },
      true,
    );
    return true;
  }

  process.stdout.write(
    `── audit search ─ matches: ${result.records.length}${result.truncated ? ' (truncated — raise --limit for more)' : ''}\n`,
  );
  process.stdout.write(`files scanned: ${result.filesScanned.length}\n`);
  for (const scanned of result.filesScanned) {
    process.stdout.write(`  • ${scanned}\n`);
  }
  process.stdout.write('\n');

  if (result.records.length === 0) {
    process.stdout.write('No records matched the given criteria.\n');
    return true;
  }

  for (const record of result.records) {
    const detailStr = record.details ? ` ${JSON.stringify(record.details)}` : '';
    process.stdout.write(
      `${record.ts}  ${record.status.padEnd(7)}  ${record.action}${detailStr}\n`,
    );
  }

  return true;
}
