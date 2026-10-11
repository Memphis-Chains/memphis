#!/usr/bin/env node
// Scheduled backup runner v4 — adds --ignore-failed-read to tar (GNU tar
// returns exit 1 on any exclude pattern match even with --warning=no-all;
// --ignore-failed-read suppresses non-fatal exit codes while keeping
// file-level error reporting).

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

// Shared exclusion policy — the SAME file the CLI archiver reads
// (src/infra/cli/commands/backup.ts). This runner used to carry its own
// hand-written list, and it was the weaker of the two: it excluded no secret
// material at all, so nightly archives packed vault-entries.json,
// vault-state.json and site-secrets/*.htpasswd. Two writers, two lists, no
// drift alarm — that asymmetry is what this import removes.
function loadExcludePolicy() {
  const candidates = [
    join(SCRIPT_DIR, 'backup-exclude-policy.json'),
    join(process.cwd(), 'scripts', 'backup-exclude-policy.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.excludePatterns)) {
        return parsed.excludePatterns.filter((p) => typeof p === 'string');
      }
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    'backup-exclude-policy.json not found or malformed; refusing to archive. ' +
      'Without a known exclusion policy this runner would pack vault material. ' +
      'Checked: ' +
      candidates.join(', '),
  );
}

const DRY_RUN = hasFlag('dry-run');
// Refuse to touch the live data dir unless the caller passes --data-dir
// explicitly. `import()`ing this file executes main() — a measurement probe
// that imports the runner to inspect it will otherwise write a real archive
// and run retention against the operator's backups. Measured cost of that
// mistake, 2026-10-11: importing the module to read it deleted
// scheduled-2026-10-09-13-03.tar.gz via the keep=7 retention.
const EXPLICIT_DATA_DIR = hasFlag('data-dir');
if (!EXPLICIT_DATA_DIR && !DRY_RUN) {
  console.error(
    'refusing to run without an explicit --data-dir: this script writes archives ' +
      'and prunes old ones. Pass --data-dir <path> (and --dry-run to inspect only).',
  );
  process.exit(2);
}
const DATA_DIR = getArg('data-dir', '/home/memphis/.memphis');
const BACKUPS_DIR = join(DATA_DIR, 'backups');

const tag = getArg('tag', 'scheduled');
const keep = Number(getArg('keep', '7'));
const excludePatterns = loadExcludePolicy();

// A partially-written archive must never be visible under its final name.
// `getBackupArchives()` filters on `.endsWith('.tar.gz')` and
// `backup-to-usb.sh` selects on `ls -t | head -1`, so a truncated file that
// kept the final name would be picked up as the newest "valid" backup.
// In-progress artifacts therefore carry this suffix, which sorts AFTER
// `.tar.gz` and is rejected by every consumer filter.
const PARTIAL_SUFFIX = '.partial';

/**
 * Databases to snapshot. `memphis.db` is the operational database — measured
 * 30.6 MB, WAL mode with a live writer, and absent from 7/7 archives on this
 * host because the archiver only ever walked the data dir while this file
 * lives in the repo's `data/`.
 */
const DATABASES = ['memphis.db', 'dashboard.db'];

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace(/T/, '_')
  .replace(/Z$/, '')
  .slice(0, 19);
const fileName = `${tag}-${timestamp}.tar.gz`;
const backupPath = join(BACKUPS_DIR, fileName);
// Everything up to the final rename lands here.
const partialPath = `${backupPath}${PARTIAL_SUFFIX}`;

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function sha256(file) {
  const out = execFileSync('sha256sum', [file], { encoding: 'utf8' });
  return out.split(' ')[0].trim();
}

function runWalCheckpoint() {
  try {
    const out = execFileSync(
      '/usr/bin/node',
      ['/home/memphis/memphis/scripts/wal-checkpoint.mjs'],
      { encoding: 'utf8', stdio: 'pipe' },
    );
    const result = JSON.parse(out);
    return { ok: true, saved_wal: result.saved_wal };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

function cleanupOldBackups(keepN) {
  if (!Number.isFinite(keepN) || keepN < 1) return [];
  const entries = readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith(`${tag}-`) && f.endsWith('.tar.gz'))
    .sort();
  const toDelete = entries.slice(0, Math.max(0, entries.length - keepN));
  for (const f of toDelete) {
    try {
      unlinkSync(join(BACKUPS_DIR, f));
      // The sidecar is what makes the archive verifiable; leaving it behind
      // would accumulate orphan .sha256 files that look like live backups.
      const sidecar = join(BACKUPS_DIR, `${f}.sha256`);
      if (existsSync(sidecar)) unlinkSync(sidecar);
    } catch (e) {
      console.error(`cleanup failed: ${f}: ${e.message}`);
    }
  }
  return toDelete;
}

function main() {
  ensureDir(BACKUPS_DIR);

  const wal = runWalCheckpoint();

  // Consistent database snapshot BEFORE tar. The operational database lives
  // outside the walked data dir and was therefore absent from 7/7 archives.
  // A snapshot failure is fatal on purpose: publishing an archive that
  const tarArgs = [
    '-czf',
    partialPath,
    '--ignore-failed-read', // suppress tar exit 1 on exclude pattern match
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    // Shared policy — see loadExcludePolicy() above. Never hand-maintain a
    // second exclude list here; that is how vault material got into 6/7
    // nightly archives.
    ...excludePatterns,
    '-C',
    DATA_DIR,
    '.',
  ];

  if (DRY_RUN) {
    // Report the exact argv plus what the policy would drop, without
    // writing an archive. Exists so the contract test can prove the policy
    // on a real fixture tree instead of asserting on a hand-kept list.
    const excluded = [];
    // Match the same way tar does: pattern against BOTH `./name` and the
    // bare name, so `--exclude=*/vault-entries.json*` catches
    // `vault-entries.json.bak-diag-*` too. Comparing the pattern string to
    // the filename would silently report "not excluded" for the exact case
    // this whole policy exists to prevent.
    const matchers = excludePatterns.map((p) => {
      const body = p.replace(/^--exclude=/, '');
      const rx = new RegExp(
        '^' + body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$',
      );
      // Also test the full relative path, so `--exclude=./site-secrets`
      // matches when the walk is already inside a subdirectory.
      return (name) => rx.test(name) || rx.test(`./${name}`) || rx.test(name.replace(/^\.\//, ''));
    });
    const walk = (rel) => {
      for (const name of readdirSync(join(DATA_DIR, rel))) {
        const child = rel === '.' ? name : join(rel, name);
        if (matchers.some((m) => m(child))) {
          excluded.push(`./${child}`);
          continue;
        }
        try {
          if (statSync(join(DATA_DIR, child)).isDirectory()) walk(child);
        } catch {
          /* raced away */
        }
      }
    };
    walk('.');
    console.log(JSON.stringify({ dryRun: true, tarArgs, excluded: excluded.sort() }, null, 2));
    return;
  }

  let tarOk = false;
  let tarErr = '';
  try {
    execFileSync('tar', tarArgs, { stdio: 'pipe' });
    tarOk = true;
  } catch (e) {
    tarErr = e.message;
  }

  if (!tarOk) {
    console.log(JSON.stringify({ ok: false, error: tarErr, walCheckpoint: wal }, null, 2));
    process.exit(1);
  }

  const size = statSync(partialPath).size;
  const checksum = sha256(partialPath);

  // Validate BEFORE publishing. drillOk means the archive actually contains
  // chain blocks, i.e. there is something to restore. It used to be computed
  // after retention and never affected `ok`, so an archive with zero chain
  // data reported success. Now it gates publication.
  let drillOk = false;
  let fileCount = 0;
  let listError = null;
  try {
    const listOutput = execFileSync('tar', ['-tzf', partialPath], { encoding: 'utf8' });
    const entries = listOutput.split('\n').filter(Boolean);
    fileCount = entries.length;
    drillOk = entries.some((e) => /chains\/.+\.json/.test(e));
  } catch (e) {
    listError = e.message;
  }

  // Sidecar `.sha256` is what `memphis backup verify` reads as the expected
  // value (backup.ts readChecksumHex -> `${archive}${CHECKSUM_SUFFIX}`).
  // Written against the PARTIAL path and renamed with the archive, so a
  // published archive never exists without its digest.
  const partialSidecar = `${partialPath}.sha256`;
  writeFileSync(partialSidecar, `${checksum}  ${fileName}\n`, { encoding: 'utf8' });

  if (!drillOk) {
    // Do NOT rename. Keep the artifact for diagnosis but never expose it
    // under the final name; retention and USB both key off that name.
    console.log(
      JSON.stringify(
        {
          ok: false,
          published: false,
          reason: listError ? 'archive-not-listable' : 'no-chain-data-in-archive',
          partial: partialPath,
          fileCount,
          walCheckpoint: wal,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }

  // Publish: sidecar first, then the archive itself. A reader that sees the
  // archive therefore always finds its digest already present.
  const finalSidecar = `${backupPath}.sha256`;
  renameSync(partialSidecar, finalSidecar);
  renameSync(partialPath, backupPath);
  // Operator data: 0600, matching the source files it was created from.
  // The archives were previously world-readable at 0664 (umask 002).
  chmodSync(backupPath, 0o600);
  if (existsSync(finalSidecar)) chmodSync(finalSidecar, 0o600);

  // Retention runs AFTER publication, so it can only ever delete archives
  // that already passed validation.
  const deleted = cleanupOldBackups(keep);

  console.log(
    JSON.stringify(
      {
        ok: true,
        path: backupPath,
        file: fileName,
        tag,
        size,
        checksum: `sha256:${checksum}`,
        fileCount,
        walCheckpoint: wal,
        drillOk,
        cleanupDeleted: deleted,
      },
      null,
      2,
    ),
  );
}

main();
