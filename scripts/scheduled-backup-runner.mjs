#!/usr/bin/env node
// Scheduled backup runner v4 — adds --ignore-failed-read to tar (GNU tar
// returns exit 1 on any exclude pattern match even with --warning=no-all;
// --ignore-failed-read suppresses non-fatal exit codes while keeping
// file-level error reporting).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = '/home/memphis/.memphis';
const BACKUPS_DIR = join(DATA_DIR, 'backups');

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const tag = getArg('tag', 'scheduled');
const keep = Number(getArg('keep', '7'));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/T/, '_').replace(/Z$/, '').slice(0, 19);
const fileName = `${tag}-${timestamp}.tar.gz`;
const backupPath = join(BACKUPS_DIR, fileName);

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
    } catch (e) {
      console.error(`cleanup failed: ${f}: ${e.message}`);
    }
  }
  return toDelete;
}

function main() {
  ensureDir(BACKUPS_DIR);

  const wal = runWalCheckpoint();

  const tarArgs = [
    '-czf', backupPath,
    '--ignore-failed-read',  // suppress tar exit 1 on exclude pattern match
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    '--exclude=./backups',
    '--exclude=./cache',
    '--exclude=./logs',
    '--exclude=*.lock',
    '--exclude=*.wal',
    '--exclude=*.shm',
    '-C', DATA_DIR,
    '.',
  ];

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

  const size = statSync(backupPath).size;
  const checksum = sha256(backupPath);
  const deleted = cleanupOldBackups(keep);

  let drillOk = false;
  let fileCount = 0;
  try {
    const listOutput = execFileSync('tar', ['-tzf', backupPath], { encoding: 'utf8' });
    const entries = listOutput.split('\n').filter(Boolean);
    fileCount = entries.length;
    drillOk = entries.some((e) => /chains\/.+\.json/.test(e));
  } catch {
    drillOk = false;
  }

  console.log(JSON.stringify({
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
  }, null, 2));
}

main();
