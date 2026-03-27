#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Get script directory (not cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const distEntry = resolve(packageRoot, 'dist/infra/cli/index.js');

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
