/**
 * `memphis export trajectories` CLI (Y1 Q1 N9 PR C).
 *
 * Writes one JSONL file per exported trajectory plus a manifest with
 * summary counters. Output directory is flat by design: consumers can
 * `for f in *.jsonl` without knowing session UUIDs in advance.
 *
 * Usage:
 *   memphis export trajectories --out <dir> [--since ISO] [--consent X]
 *                                [--dry-run] [--json]
 *
 * Flags:
 *   --out <dir>       Required. Output directory (created if absent).
 *   --since ISO       Optional. Only events with timestamp ≥ ISO export.
 *   --consent LEVEL   'exportable' (default), 'anonymized', 'local-only',
 *                     or 'all'. 'all' requires MEMPHIS_EXPORT_CONFIRM=1.
 *   --dry-run         Summarize without writing files.
 *   --json            Print structured summary.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  exportTrajectories,
  type ExportTrajectoriesInput,
} from '../../../trajectory/exporter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type ConsentFlag = NonNullable<ExportTrajectoriesInput['consent']>;

function isValidConsent(raw: string): raw is ConsentFlag {
  return raw === 'exportable' || raw === 'anonymized' || raw === 'local-only' || raw === 'all';
}

/**
 * Returns `true` when the command was handled (command === 'export' +
 * subcommand === 'trajectories'). Caller should match first-true-wins
 * per the existing `src/infra/cli/commands/*` pattern.
 */
export async function handleExportTrajectoriesCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'export' || context.args.subcommand !== 'trajectories') {
    return false;
  }

  const { json, out, since, consent: consentRaw, dryRun } = context.args;
  const consent = consentRaw ?? 'exportable';

  if (!dryRun && (!out || out.trim().length === 0)) {
    throw new Error(
      'export trajectories requires --out <dir> (or --dry-run to summarize without writing)',
    );
  }

  if (!isValidConsent(consent)) {
    throw new Error(
      `invalid --consent value '${consent}' (expected exportable|anonymized|local-only|all)`,
    );
  }

  const opts: ExportTrajectoriesInput = {
    consent,
    sinceIso: since,
    rawEnv: process.env,
  };

  const result = await exportTrajectories(opts);

  if (dryRun) {
    print(
      {
        ok: true,
        data: {
          dryRun: true,
          ...result.summary,
          skipped: result.skipped.length,
        },
      },
      json,
    );
    return true;
  }

  const targetDir = resolve(out as string);
  await mkdir(targetDir, { recursive: true });

  const writtenFiles: string[] = [];
  for (const trajectory of result.trajectories) {
    const fname = `${trajectory.trajectoryId}.jsonl`;
    const fpath = join(targetDir, fname);
    // Self-describing JSONL: first line is `_meta` envelope, then one
    // event per line in chronological order.
    const meta = {
      _meta: {
        schemaVersion: trajectory.schemaVersion,
        trajectoryId: trajectory.trajectoryId,
        sessionId: trajectory.sessionId,
        agentIdentity: trajectory.agentIdentity,
        startedAt: trajectory.startedAt,
        completedAt: trajectory.completedAt,
        turns: trajectory.turns,
        integrity: trajectory.integrity,
      },
    };
    const lines = [JSON.stringify(meta), ...trajectory.events.map((e) => JSON.stringify(e))];
    await writeFile(fpath, lines.join('\n') + '\n', 'utf8');
    writtenFiles.push(fname);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    outDir: targetDir,
    files: writtenFiles,
    summary: result.summary,
    skippedCount: result.skipped.length,
  };
  await writeFile(join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  print(
    {
      ok: true,
      data: {
        outDir: targetDir,
        files: writtenFiles.length,
        ...result.summary,
        skipped: result.skipped.length,
      },
    },
    json,
  );
  return true;
}
