#!/usr/bin/env node
// WAL checkpoint runner for memphis.db
// Defensive: integrity-check first, then atomic TRUNCATE.
// Uses Node 22 built-in node:sqlite (experimental, but stable enough for our use).
// Usage: node scripts/wal-checkpoint.js [--dry-run]

import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = '/home/memphis/memphis/data/memphis.db';
const WAL_PATH = DB_PATH + '-wal';
const SHM_PATH = DB_PATH + '-shm';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

function stat() {
  return {
    db: existsSync(DB_PATH) ? statSync(DB_PATH).size : null,
    wal: existsSync(WAL_PATH) ? statSync(WAL_PATH).size : null,
    shm: existsSync(SHM_PATH) ? statSync(SHM_PATH).size : null,
  };
}

function main() {
  const before = stat();
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, mode: 'dry-run', before, checkpoint: null, after: null }, null, 2));
    process.exit(0);
  }

  let db;
  try {
    db = new DatabaseSync(DB_PATH, { readOnly: false });
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: 'open', err: e.message }));
    process.exit(2);
  }

  try {
    const integ = db.prepare('PRAGMA integrity_check').get();
    if (integ.integrity_check !== 'ok') {
      console.error(JSON.stringify({ ok: false, stage: 'integrity_check', result: integ }));
      process.exit(3);
    }

    const ckpt = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    const after = stat();
    console.log(JSON.stringify({
      ok: true,
      mode: 'truncate',
      integrity: 'ok',
      checkpoint: ckpt,
      before,
      after,
      saved_wal: before.wal != null && after.wal != null ? before.wal - after.wal : null,
    }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: 'checkpoint', err: e.message }));
    process.exit(4);
  } finally {
    try {
      db.close();
    } catch (closeErr) {
      console.error(JSON.stringify({ ok: false, stage: 'close', err: closeErr.message }));
    }
  }
}

main();
