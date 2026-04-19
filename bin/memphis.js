#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Get script directory (not cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const distEntry = resolve(packageRoot, 'dist/infra/cli/index.js');

// Codex Round 6 P1 fix (PR #124): bump the boot-attempt counter BEFORE
// any dist module imports. If a bad self-modify commit introduced a
// syntax / import-time crash in a module bootstrap.ts statically
// imports, the old recordBootAttempt call inside bootstrap() never
// ran, so the auto-revert counter never advanced. By counting here
// (pre-import, using only node built-ins) we guarantee a crash loop
// is visible to evaluateAutoRevert on the next boot.
//
// Only bumps for the `serve` entry — `memphis <other>` CLI invocations
// are diagnostic and shouldn't contribute.
function recordBootAttemptEarly() {
  if (process.argv[2] !== 'serve') return;
  try {
    const dataDir = process.env.MEMPHIS_DATA_DIR ?? join(process.env.HOME ?? '/tmp', '.memphis');
    const statePath = join(dataDir, 'state', 'boot-failures.json');
    mkdirSync(dirname(statePath), { recursive: true });
    let record = { failures: [] };
    try {
      if (existsSync(statePath)) {
        record = JSON.parse(readFileSync(statePath, 'utf8'));
        if (!Array.isArray(record.failures)) record.failures = [];
      }
    } catch {
      /* start fresh on parse error */
    }
    record.failures.push({ at: new Date().toISOString() });
    record.failures = record.failures.slice(-50);
    writeFileSync(statePath, JSON.stringify(record), 'utf8');
    // Signal to bootstrap.ts that we already recorded this attempt so
    // it can skip its own call — otherwise a crashing serve launch
    // double-counts, exceeding the auto-revert threshold after a single
    // real failure (#141 Codex P1).
    process.env.MEMPHIS_BOOT_ATTEMPT_RECORDED = '1';
  } catch {
    /* best-effort — never break CLI because of bookkeeping */
  }
}
recordBootAttemptEarly();

if (process.env.MEMPHIS_DEBUG) {
  console.error('[DEBUG] Package root:', packageRoot);
  console.error('[DEBUG] Dist entry:', distEntry, 'exists:', existsSync(distEntry));
}

if (!existsSync(distEntry)) {
  console.error('[ERROR] Memphis CLI build is missing.');
  console.error('[ERROR] Expected compiled entrypoint at:', distEntry);
  console.error(
    '[ERROR] Run `npm run build` in a source checkout, or use `npm run cli` / `npm run dev` for supported development entrypoints.',
  );
  process.exit(1);
}

try {
  if (process.env.MEMPHIS_DEBUG) {
    console.error('[DEBUG] Loading dist entry');
  }
  const cli = await import(distEntry);

  // Call runCli explicitly with process.argv
  if (cli.runCli) {
    await cli.runCli(process.argv);
  } else {
    console.error('[ERROR] runCli not exported from CLI module');
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error('[ERROR] Failed to load Memphis CLI:', message);
  if (stack) {
    console.error('[ERROR] Stack:', stack);
  }
  process.exit(1);
}
