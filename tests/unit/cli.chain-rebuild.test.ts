import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI chain rebuild', () => {
  it('runs chain rebuild command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-cli-chain-rebuild-'));
    const out = await runCli(['chain', 'rebuild', '--json'], { cwd: dir });
    const parsed = JSON.parse(out);

    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toBeGreaterThanOrEqual(0);
  });
});
