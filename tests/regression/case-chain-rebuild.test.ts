/**
 * Regression test: case chain index rebuild.
 *
 * Writes N case entries, verifies they are queryable,
 * then confirms rebuild returns a valid report.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaseChainAdapter } from '../../src/infra/storage/case-chain-adapter.js';
import type { CaseEntry } from '../../src/memory/case-types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-case-rebuild-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('case-chain rebuild regression', () => {
  let dataDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataDir = makeTmpDir();
    env = {
      ...process.env,
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
    };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('rebuild returns zero counts in TS fallback mode', async () => {
    const adapter = new CaseChainAdapter(env);

    const entries: CaseEntry[] = [
      {
        case_type: 'instrumental',
        actor: 'agent',
        instrument: 'web-fetch',
        target: 'api.example.com',
      },
      {
        case_type: 'accusative',
        subject: 'agent',
        verb: 'created',
        object: 'report.pdf',
      },
      {
        case_type: 'locative',
        entity: 'vault',
        location: '/data/vault',
      },
    ];

    for (const entry of entries) {
      await adapter.appendCaseEntry(entry);
    }

    // In TS fallback mode, rebuild is a no-op
    const report = await adapter.rebuildIndex();
    expect(report.indexed).toBe(0);
    expect(report.errors).toBe(0);
  });

  it('queries still work after adapter re-instantiation (cold start)', async () => {
    const adapter1 = new CaseChainAdapter(env);

    await adapter1.appendCaseEntry({
      case_type: 'dative',
      giver: 'system',
      recipient: 'agent',
      object: 'credentials',
    });
    await adapter1.appendCaseEntry({
      case_type: 'genitive',
      owner: 'agent',
      possessed: 'signing-key',
    });

    // Create a fresh adapter (simulates cold start / process restart)
    const adapter2 = new CaseChainAdapter(env);

    const result = await adapter2.queryCases({});
    expect(result.count).toBe(2);

    const dativeResult = await adapter2.queryCases({ case_type: 'dative' });
    expect(dativeResult.count).toBe(1);
    expect(dativeResult.entries[0]!.recipient).toBe('agent');
  });

  it('chain files are the source of truth after restart', async () => {
    const adapter = new CaseChainAdapter(env);

    // Write 5 entries
    for (let i = 0; i < 5; i++) {
      await adapter.appendCaseEntry({
        case_type: 'nominative',
        entity: `entity-${i}`,
        action: 'created',
        timestamp: new Date().toISOString(),
      });
    }

    // Fresh adapter reads from chain files
    const fresh = new CaseChainAdapter(env);
    const result = await fresh.queryCases({ case_type: 'nominative' });
    expect(result.count).toBe(5);

    // Verify all entities are present
    const entities = result.entries.map((e) => e.entity).sort();
    expect(entities).toEqual(['entity-0', 'entity-1', 'entity-2', 'entity-3', 'entity-4']);
  });
});
