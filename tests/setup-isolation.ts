import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll } from 'vitest';

import { createIsolatedTestRuntime } from './helpers/isolated-runtime.js';

const originalEnv = { ...process.env };
const fixture = createIsolatedTestRuntime(
  originalEnv,
  fileURLToPath(new URL('../', import.meta.url)),
);
process.env = fixture.env;

afterAll(() => {
  process.env = originalEnv;
  rmSync(fixture.root, { recursive: true, force: true });
});
