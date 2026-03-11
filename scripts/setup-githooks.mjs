import { existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = process.cwd();
const hooksDir = resolve(repoRoot, '.githooks');
const hookFile = resolve(hooksDir, 'pre-commit');

if (!existsSync(hookFile)) {
  process.exit(0);
}

try {
  chmodSync(hookFile, 0o755);
  execSync('git config core.hooksPath .githooks', { cwd: repoRoot, stdio: 'ignore' });
  console.log('[githooks] core.hooksPath set to .githooks');
} catch {
  // ignore in CI/non-git installs
}
