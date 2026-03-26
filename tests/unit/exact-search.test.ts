import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  indexExactSearchBlock,
  rebuildExactSearchIndex,
  searchExactMemory,
} from '../../src/infra/memory/exact-search.js';

function makeEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-exact-search-'));
  return {
    ...process.env,
    MEMPHIS_DATA_DIR: dir,
    DATABASE_URL: `file:${join(dir, 'memphis.db')}`,
  };
}

describe('exact search', () => {
  it('indexes journal and decision content into the FTS5 exact search path', () => {
    const env = makeEnv();

    indexExactSearchBlock(
      {
        chain: 'journal',
        index: 1,
        hash: 'hash-journal',
        data: { content: 'Marcin likes concise answers', tags: ['user', 'preferences'] },
      },
      env,
    );
    indexExactSearchBlock(
      {
        chain: 'decisions',
        index: 2,
        hash: 'hash-decision',
        data: { title: 'Recall mode', choice: 'ship FTS5 exact search', context: 'v1.0 closure' },
      },
      env,
    );

    const journal = searchExactMemory('concise answers', 5, env);
    expect(journal.count).toBe(1);
    expect(journal.hits[0]).toMatchObject({
      chain: 'journal',
      blockIndex: 1,
      content: 'Marcin likes concise answers',
      tags: ['user', 'preferences'],
    });

    const decision = searchExactMemory('ship FTS5 exact search', 5, env, 'decisions');
    expect(decision.count).toBe(1);
    expect(decision.hits[0]).toMatchObject({
      chain: 'decisions',
      blockType: 'decision',
    });
    expect(decision.hits[0].content).toContain('Choice: ship FTS5 exact search');
  });

  it('rebuilds the exact search index from durable chain files', () => {
    const env = makeEnv();
    const journalDir = join(env.MEMPHIS_DATA_DIR!, 'chains', 'journal');
    const decisionsDir = join(env.MEMPHIS_DATA_DIR!, 'chains', 'decisions');
    mkdirSync(journalDir, { recursive: true });
    mkdirSync(decisionsDir, { recursive: true });

    writeFileSync(
      join(journalDir, '000001.json'),
      JSON.stringify(
        {
          index: 1,
          hash: 'journal-hash',
          chain: 'journal',
          data: {
            content: 'Exact phrase lookup should find this sentence',
            tags: ['search'],
          },
        },
        null,
        2,
      ),
      'utf8',
    );
    writeFileSync(
      join(decisionsDir, '000001.json'),
      JSON.stringify(
        {
          index: 1,
          hash: 'decision-hash',
          chain: 'decisions',
          data: {
            title: 'Recall split',
            choice: 'semantic plus exact',
            context: 'hybrid recall milestone',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const rebuilt = rebuildExactSearchIndex({}, env);
    expect(rebuilt).toMatchObject({
      indexed: 2,
      total: 2,
      chains: ['decisions', 'journal'],
    });

    const hit = searchExactMemory('Exact phrase lookup should find this sentence', 5, env);
    expect(hit.count).toBe(1);
    expect(hit.hits[0]).toMatchObject({
      chain: 'journal',
      blockHash: 'journal-hash',
    });
  });
});
