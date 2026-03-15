import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI categorize save persistence e2e', () => {
  it('writes categorize report to journal on fresh data dir', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-categorize-e2e-'));
    const output = await runCli(['categorize', 'Prepare release checklist', '--json', '--save'], {
      env: { MEMPHIS_DATA_DIR: dataDir, RUST_CHAIN_ENABLED: 'false' },
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      saved: boolean;
      savedBlock?: { chain?: string; index?: number };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('categorize');
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
      data?: {
        type?: string;
        source?: string;
        report?: { suggestion?: { tags?: unknown[] } };
      };
    };
    expect(latest.data?.type).toBe('categorize_report');
    expect(latest.data?.source).toBe('cli.categorize');
    expect(Array.isArray(latest.data?.report?.suggestion?.tags)).toBe(true);
  });
});
