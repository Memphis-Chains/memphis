import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll } from 'vitest';

import { createIsolatedTestRuntime } from './helpers/isolated-runtime.js';

const originalEnv = { ...process.env };
const fixture = createIsolatedTestRuntime(
  originalEnv,
  fileURLToPath(new URL('../', import.meta.url)),
);

// Mutate process.env IN PLACE. Replacing the object (`process.env = {...}`)
// disconnects the JavaScript view of the environment from the OS one: Node
// keeps `process.env` as a special object backed by the real environment, so
// a plain replacement makes `os.homedir()` and the Rust bridge (which read
// the OS environment through std::env::var) ignore every override the test
// makes. Measured: with a replaced object, `os.homedir()` still returned
// /home/memphis after the test set HOME=/tmp/... .
for (const key of Object.keys(process.env)) {
  if (!(key in fixture.env)) delete process.env[key];
}
Object.assign(process.env, fixture.env);

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  rmSync(fixture.root, { recursive: true, force: true });
});
