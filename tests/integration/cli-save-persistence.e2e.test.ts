import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

type SavedCliResponse = {
  ok: boolean;
  mode: string;
  saved: boolean;
  savedBlock?: { chain?: string; index?: number };
};

describe('CLI save persistence e2e', () => {
  // Revival 2026-05-08 — original test was skipped because:
  // 1. `data.type='insight_report'` assertion was the pre-canonical
  //    shape; cognitive handlers now write `{type:'insight',
  //    kind:'*_report'}` to match the chain-catalog journal type set.
  // 2. The original env didn't pin a provider, so `insights` and
  //    `reflect` failed against missing-LLM in CI.
  //
  // Both fixed: pin DEFAULT_PROVIDER=local-fallback so the cognitive
  // handlers complete deterministically without a live LLM, and assert
  // on the canonical `kind` discriminator.
  it('persists insights, categorize, and reflections in one fresh data directory', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-cli-save-persistence-'));
    const env = {
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
      DEFAULT_PROVIDER: 'local-fallback',
    };

    const insightOutput = await runCli(['insights', '--json', '--save'], { env });
    const categorizeOutput = await runCli(
      ['categorize', 'Stabilize release checklist', '--json', '--save'],
      { env },
    );
    const reflectOutput = await runCli(['reflect', '--json', '--save'], { env });

    const insight = JSON.parse(insightOutput) as SavedCliResponse;
    const categorize = JSON.parse(categorizeOutput) as SavedCliResponse;
    const reflect = JSON.parse(reflectOutput) as SavedCliResponse;

    expect(insight.ok).toBe(true);
    expect(insight.mode).toBe('insights');
    expect(insight.saved).toBe(true);
    expect(insight.savedBlock?.chain).toBe('journal');
    expect(typeof insight.savedBlock?.index).toBe('number');

    expect(categorize.ok).toBe(true);
    expect(categorize.mode).toBe('categorize');
    expect(categorize.saved).toBe(true);
    expect(categorize.savedBlock?.chain).toBe('journal');
    expect(typeof categorize.savedBlock?.index).toBe('number');

    expect(reflect.ok).toBe(true);
    expect(reflect.mode).toBe('reflect');
    expect(reflect.saved).toBe(true);
    expect(reflect.savedBlock?.chain).toBe('journal');
    expect(typeof reflect.savedBlock?.index).toBe('number');

    expect(categorize.savedBlock?.index ?? 0).toBeGreaterThan(insight.savedBlock?.index ?? 0);
    expect(reflect.savedBlock?.index ?? 0).toBeGreaterThan(categorize.savedBlock?.index ?? 0);

    const journalDir = join(dataDir, 'chains', 'journal');
    expect(existsSync(journalDir)).toBe(true);

    const files = readdirSync(journalDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(files.length).toBeGreaterThanOrEqual(3);

    // Canonical envelope: `type` is the chain-catalog BlockType variant
    // ('insight' for the journal chain), `kind` is the report sub-type.
    const blockKinds = new Set(
      files.map((file) => {
        const parsed = JSON.parse(readFileSync(join(journalDir, file), 'utf8')) as {
          data?: { type?: string; kind?: string };
        };
        return parsed.data?.kind;
      }),
    );
    expect(blockKinds.has('insight_report')).toBe(true);
    expect(blockKinds.has('categorize_report')).toBe(true);
    expect(blockKinds.has('reflection_report')).toBe(true);
  });
});
