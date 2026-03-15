import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI categorize', () => {
  it('returns categorization suggestion in JSON mode', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-categorize-json-'));
    const output = await runCli(['categorize', 'Need weekly sprint review', '--json'], {
      env: { MEMPHIS_DATA_DIR: dataDir, DEFAULT_PROVIDER: 'local-fallback' },
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      mode: string;
      input: string;
      saved: boolean;
      savedBlock: null;
      suggestion: {
        tags?: Array<{ tag?: string; confidence?: number }>;
        overallConfidence?: number;
      };
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('categorize');
    expect(parsed.input).toBe('Need weekly sprint review');
    expect(parsed.saved).toBe(false);
    expect(parsed.savedBlock).toBeNull();
    expect(Array.isArray(parsed.suggestion.tags)).toBe(true);
    expect(typeof parsed.suggestion.overallConfidence).toBe('number');
  });

  it('persists categorize report block to journal when --save is requested', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-categorize-save-'));
    const output = await runCli(['categorize', 'Deploy hotfix for API', '--json', '--save'], {
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
        schemaVersion?: number;
        source?: string;
        report?: { input?: string };
      };
    };
    expect(latest.data?.type).toBe('categorize_report');
    expect(latest.data?.schemaVersion).toBe(1);
    expect(latest.data?.source).toBe('cli.categorize');
    expect(latest.data?.report?.input).toBe('Deploy hotfix for API');
  });
});
