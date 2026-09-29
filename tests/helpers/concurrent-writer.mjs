#!/usr/bin/env node
// tests/helpers/concurrent-writer.mjs
//
// Concurrency-test child process for ADR-009 (issue #626 race regression).
//
// Usage:
//   node tests/helpers/concurrent-writer.mjs --dir <chainsdir> --index <n> --payload <json>
//
// Exits 0 if writeBlockAtomic returned a file path; exits 1 with stderr
// detail if it threw; exits 2 if the runtime import failed (most likely
// because dist/ is missing — run `npm run build` first).
//
// Logs each step to `<dir>/.concurrent-writer.log` so the parent test can
// reason about the race order post-hoc.

import { appendFileSync } from 'node:fs';
import { argv, exit } from 'node:process';
import { join } from 'node:path';

function parseArgs(argvList) {
  // tolerate repeated flags; we only use the last value
  const out = {};
  for (let i = 0; i < argvList.length; i += 1) {
    const cur = argvList[i];
    if (cur.startsWith('--')) {
      const key = cur.slice(2);
      out[key] = argvList[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(argv.slice(2));

  if (!args.dir || args.index === undefined || !args.payload) {
    console.error(
      JSON.stringify({
        ok: false,
        stage: 'args',
        err: 'missing --dir / --index / --payload',
      }),
    );
    exit(1);
  }

  const logPath = join(args.dir, '.concurrent-writer.log');
  const log = (msg) => {
    appendFileSync(logPath, `[pid=${process.pid} t=${Date.now()}] ${msg}\n`);
  };

  let writeBlockAtomic;
  try {
    const mod = await import('../../dist/infra/storage/chain-file-io.js');
    writeBlockAtomic = mod.writeBlockAtomic;
    if (typeof writeBlockAtomic !== 'function') {
      throw new Error('writeBlockAtomic export not a function');
    }
  } catch (err) {
    log(`import failed: ${String(err)}`);
    console.error(
      JSON.stringify({
        ok: false,
        stage: 'import',
        err: String(err),
        hint: 'run `npm run build` first so dist/infra/storage/chain-file-io.js exists',
      }),
    );
    exit(2);
  }

  try {
    const file = await writeBlockAtomic(args.dir, Number(args.index), args.payload);
    log(`wrote ${file}`);
    console.log(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        file,
      }),
    );
    exit(0);
  } catch (err) {
    log(`threw: ${String(err)}`);
    console.error(
      JSON.stringify({
        ok: false,
        pid: process.pid,
        err: String(err),
      }),
    );
    exit(1);
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ok: false,
      stage: 'unexpected',
      err: String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  exit(3);
});
