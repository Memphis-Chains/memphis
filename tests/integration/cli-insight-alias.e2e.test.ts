import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI insight alias integration', () => {
  it('routes legacy `insight` command to active insights handler', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-insight-alias-'));
    const output = await runCli(['insight', '--json'], {
      env: { MEMPHIS_DATA_DIR: dataDir, DEFAULT_PROVIDER: 'local-fallback' },
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      window: string;
      saved: boolean;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('insights');
    expect(parsed.window).toBe('daily');
    expect(parsed.saved).toBe(false);
  });

  it('persists journal insight report when using legacy alias with --save', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-insight-alias-save-'));
    const output = await runCli(['insight', '--json', '--save'], {
      env: { MEMPHIS_DATA_DIR: dataDir, RUST_CHAIN_ENABLED: 'false' },
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      saved: boolean;
      savedBlock?: { chain?: string; index?: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.saved).toBe(true);
    expect(parsed.savedBlock?.chain).toBe('journal');
    expect(typeof parsed.savedBlock?.index).toBe('number');

    const journalDir = join(dataDir, 'chains', 'journal');
    expect(existsSync(journalDir)).toBe(true);
    const files = readdirSync(journalDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThan(0);

    const latest = JSON.parse(readFileSync(join(journalDir, files.at(-1) ?? ''), 'utf8')) as {
      data?: { type?: string; source?: string };
    };
    expect(latest.data?.type).toBe('insight_report');
    expect(latest.data?.source).toBe('cli.insights');
  });
});
