import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll } from 'vitest';

import { applyEnvInPlace, createIsolatedTestRuntime } from './helpers/isolated-runtime.js';

const originalEnv = { ...process.env };
const fixture = createIsolatedTestRuntime(
  originalEnv,
  fileURLToPath(new URL('../', import.meta.url)),
);
// Apply in place, never replace the object: `process.env` assignments are
// what reach the process environment, and `os.homedir()` reads that
// environment. Replacing the object left `os.homedir()` pointing at the
// operator's real home — which is how a test run wrote fixture blocks into
// the live journal chain on 2026-10-24.
applyEnvInPlace(process.env, fixture.env);

afterAll(() => {
  applyEnvInPlace(process.env, originalEnv);
  rmSync(fixture.root, { recursive: true, force: true });
});
