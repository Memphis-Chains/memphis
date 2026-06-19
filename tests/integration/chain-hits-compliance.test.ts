/**
 * Sprint J behavioral close — verifies the chain_hits escalation
 * contract from the prepareCognitivePrelude/system-prompt side.
 *
 * The 2026-05-05 confabulation gap: system prompt instructs the bot
 * to quote `[chain_hits]` and escalate to recall/search/chain_query
 * when the prelude is empty. soul-cognitive-loop.test.ts pins the
 * autonomy-mode round-trip; this test pins the OTHER half — that
 * the prelude actually populates `[chain_hits]` from FTS5 hits when
 * relevant data exists, and falls back to an empty fragment when it
 * doesn't.
 *
 * Tests use `indexExactSearchBlock` to seed a real FTS5 index in a
 * tmpdir-scoped MEMPHIS_DATA_DIR, then call prepareCognitivePrelude
 * directly. loadCognitiveBlocks is bypassed (its rust-side reads
 * require seeded chain JSON files which is orthogonal to the
 * `[chain_hits]` block we're verifying — exact-search hits drive
 * the marker, not the recent-blocks list).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareCognitivePrelude } from '../../src/gateway/cognitive-runtime.js';
import { indexExactSearchBlock } from '../../src/infra/memory/exact-search.js';

interface Sandbox {
  dataDir: string;
  prevDataDir: string | undefined;
  prevDatabaseUrl: string | undefined;
  prevNodeEnv: string | undefined;
}

function setup(): Sandbox {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-hits-'));
  const prevDataDir = process.env.MEMPHIS_DATA_DIR;
  const prevDatabaseUrl = process.env.DATABASE_URL;
  const prevNodeEnv = process.env.NODE_ENV;

  process.env.MEMPHIS_DATA_DIR = dataDir;
  process.env.DATABASE_URL = `file:${join(dataDir, 'memphis.db')}`;
  // shouldUseTestIsolatedCognitiveState short-circuits when NODE_ENV=test
  // AND MEMPHIS_DATA_DIR is empty. We want the real path here, so override.
  process.env.NODE_ENV = 'integration';

  return { dataDir, prevDataDir, prevDatabaseUrl, prevNodeEnv };
}

function teardown(sandbox: Sandbox): void {
  rmSync(sandbox.dataDir, { recursive: true, force: true });
  if (sandbox.prevDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
  else process.env.MEMPHIS_DATA_DIR = sandbox.prevDataDir;
  if (sandbox.prevDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = sandbox.prevDatabaseUrl;
  if (sandbox.prevNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = sandbox.prevNodeEnv;
}

describe('cognitive prelude — chain_hits behavioral compliance', () => {
  let sandbox: Sandbox;

  beforeEach(() => {
    sandbox = setup();
  });

  afterEach(() => {
    teardown(sandbox);
  });

  it('renders [chain_hits] block in promptFragment when FTS5 has matches for the query', async () => {
    // Seed three journal entries — only one matches the query word.
    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 1,
        hash: 'hash-journal-1',
        data: {
          content: 'operator preferred model: cogito:3b for offline coding',
          tags: ['preferences', 'model', 'offline'],
        },
      },
      process.env,
    );
    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 2,
        hash: 'hash-journal-2',
        data: {
          content: 'unrelated reflection about coffee preferences',
          tags: ['journal'],
        },
      },
      process.env,
    );
    indexExactSearchBlock(
      {
        chain: 'decisions',
        index: 3,
        hash: 'hash-decision-3',
        data: {
          title: 'Pick provider',
          choice: 'cogito:3b for cold-start work',
          context: 'low-latency offline preference',
        },
      },
      process.env,
    );

    const prelude = await prepareCognitivePrelude('offline coding');

    // The exact-search side returned at least one hit relevant to our seed
    expect(prelude.exact.count).toBeGreaterThanOrEqual(1);
    expect(prelude.exact.hits.length).toBeGreaterThanOrEqual(1);
    // The fragment carries the contract marker the system prompt
    // teaches the bot to look for + the matched content
    expect(prelude.promptFragment).toContain('[chain_hits]');
    expect(prelude.promptFragment).toMatch(/cogito|offline/);
  });

  it('emits an empty promptFragment when FTS5 has no hits for the query', async () => {
    // Seed something the query won't match at all
    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 1,
        hash: 'hash-journal-1',
        data: {
          content: 'completely unrelated weather log entry',
          tags: ['weather'],
        },
      },
      process.env,
    );

    const prelude = await prepareCognitivePrelude(
      'what did the operator say about quantum cryptography migration plans',
    );

    expect(prelude.exact.count).toBe(0);
    expect(prelude.exact.hits).toHaveLength(0);
    // No exact hits → buildPromptFragment skips the [chain_hits]
    // section entirely. The bot therefore needs to escalate per the
    // system-prompt rules ("if [chain_hits] empty, call memphis_recall").
    expect(prelude.promptFragment).not.toContain('[chain_hits]');
  });

  it('caps chain_hits at 3 even when FTS5 has more matches', async () => {
    // Seed five matching entries — the prelude builder slices to 3
    // (per cognitive-runtime.ts:101 summarizeExact slice(0, 3)).
    // This pins the cap so a future change toward unbounded injection
    // doesn't silently bloat the system prompt.
    for (let i = 1; i <= 5; i += 1) {
      indexExactSearchBlock(
        {
          chain: 'journal',
          index: i,
          hash: `hash-journal-${i}`,
          data: {
            content: `entry ${i}: voicemail transcription pipeline reflection`,
            tags: ['voicemail', 'pipeline'],
          },
        },
        process.env,
      );
    }

    const prelude = await prepareCognitivePrelude('voicemail pipeline');

    // searchExactMemory was called with limit=3 by prepareCognitivePrelude,
    // so we get at most 3 hits even though 5 match.
    expect(prelude.exact.hits.length).toBeLessThanOrEqual(3);
    // The rendered fragment shouldn't have more than 3 chain_hits lines
    // (3 hits + 1 header line).
    const lines = prelude.promptFragment.split('\n');
    const chainHitLines = lines.filter((line) => line.startsWith('- journal#'));
    expect(chainHitLines.length).toBeLessThanOrEqual(3);
  });

  it('filters unsafe exact hits out of cognitive prompt fragments', async () => {
    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 1,
        hash: 'hash-journal-unsafe',
        data: {
          content: 'old telegram transcript mentioned system prompt and hidden instructions',
          tags: ['tools', 'conversation'],
        },
      },
      process.env,
    );
    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 2,
        hash: 'hash-journal-safe',
        data: {
          content: 'safe tools inventory summary for runtime capabilities',
          tags: ['tools', 'runtime'],
        },
      },
      process.env,
    );

    const prelude = await prepareCognitivePrelude('tools runtime');

    expect(prelude.exact.hits.map((hit) => hit.sourceKey)).toEqual(['journal:2']);
    expect(prelude.promptFragment).toContain('[chain_hits]');
    expect(prelude.promptFragment).toContain('safe tools inventory');
    expect(prelude.promptFragment).not.toContain('system prompt');
    expect(prelude.promptFragment).not.toContain('hidden instructions');
  });
});
