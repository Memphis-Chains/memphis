#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const distEntry = resolve(process.cwd(), 'dist/infra/cli/index.js');
const srcEntry = resolve(process.cwd(), 'src/infra/cli/index.ts');

if (existsSync(distEntry)) {
  await import(distEntry);
} else {
  await import(srcEntry);
}
