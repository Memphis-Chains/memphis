import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';
import { realTmpdir } from '../helpers/tmpdir.js';

describe('CLI tui output', () => {
  it('prints framed output for --tui', { timeout: 60_000 }, async () => {
    // Post-S10-5 (#393), `ask`/`chat`/`tui` reject with NOT_INITIALIZED
    // when no first-run record exists. Set up an isolated tmpdir + minimal
    // initialized-clean stub at <dataDir>/config/first-run.json so the
    // gate clears and we can exercise the actual --tui rendering.
    const dataDir = mkdtempSync(join(realTmpdir(), 'memphis-cli-tui-'));
    mkdirSync(join(dataDir, 'config'), { recursive: true });
    writeFileSync(
      join(dataDir, 'config', 'first-run.json'),
      JSON.stringify({
        schemaVersion: 1,
        initializedAt: '2026-05-02T00:00:00.000Z',
        mode: 'minimal-baseline',
        createdChains: [],
        createdBlocks: 0,
        summary: 'cli.tui test stub for first-run gate (S10-5 bypass)',
        origin: 'controlled-init',
      }),
      'utf8',
    );

    const out = await runCli(['ask', '--input', 'hello', '--tui'], {
      env: {
        DEFAULT_PROVIDER: 'local-fallback',
        MEMPHIS_DATA_DIR: dataDir,
      },
    });

    expect(out).toContain('memphis ask');
    expect(out).toContain('╔');
    expect(out).toContain('╚');
  });
});
