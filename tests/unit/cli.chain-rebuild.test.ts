import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const cliPath = resolve(repoRoot, 'src/infra/cli/index.ts');

describe('CLI chain rebuild', () => {
  it('runs chain rebuild command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-cli-chain-rebuild-'));
    const out = execSync(`npx tsx ${cliPath} chain rebuild --json`, {
      cwd: dir,
      encoding: 'utf8',
    });

    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toBeGreaterThanOrEqual(0);
  });
});
