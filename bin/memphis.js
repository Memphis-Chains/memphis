#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// Get script directory (not cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = resolve(__dirname, '..');

const distEntry = resolve(packageRoot, 'dist/infra/cli/index.js');
const srcEntry = resolve(packageRoot, 'src/infra/cli/index.ts');

if (process.env.MEMPHIS_DEBUG) {
  console.error('[DEBUG] Package root:', packageRoot);
  console.error('[DEBUG] Dist entry:', distEntry, 'exists:', existsSync(distEntry));
  console.error('[DEBUG] Src entry:', srcEntry, 'exists:', existsSync(srcEntry));
}

try {
  let cli;
  if (existsSync(distEntry)) {
    if (process.env.MEMPHIS_DEBUG) {
      console.error('[DEBUG] Loading dist entry');
    }
    cli = await import(distEntry);
  } else {
    if (process.env.MEMPHIS_DEBUG) {
      console.error('[DEBUG] Loading src entry');
    }
    cli = await import(srcEntry);
  }

  // Call runCli explicitly with process.argv
  if (cli.runCli) {
    await cli.runCli(process.argv);
  } else {
    console.error('[ERROR] runCli not exported from CLI module');
    process.exit(1);
  }
} catch (error) {
  console.error('[ERROR] Failed to load Memphis CLI:', error.message);
  console.error('[ERROR] Stack:', error.stack);
  process.exit(1);
}
