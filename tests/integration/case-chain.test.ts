/**
 * Integration tests for the case-based chain system.
 *
 * Verifies CaseChainAdapter append/query cycle, hash chain integrity,
 * all 8 case types, and TS fallback mode.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CaseChainAdapter } from '../../src/infra/storage/case-chain-adapter.js';
import type { CaseEntry } from '../../src/memory/case-types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-case-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('case-chain integration', () => {
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

  it('appends a nominative case entry and writes block file', async () => {
    const adapter = new CaseChainAdapter(env);
    const entry: CaseEntry = {
      case_type: 'nominative',
      entity: 'agent-alpha',
      action: 'initialized',
      timestamp: new Date().toISOString(),
    };

    const result = await adapter.appendCaseEntry(entry);

    expect(result.success).toBe(true);
    expect(result.index).toBe(1);
    expect(result.chain).toBe('cases');
    expect(result.case_type).toBe('nominative');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);

    // Verify block file exists
    const casesDir = join(dataDir, 'chains', 'cases');
    const files = readdirSync(casesDir);
    expect(files).toContain('000001.json');

    // Verify block shape
    const block = JSON.parse(readFileSync(join(casesDir, '000001.json'), 'utf8'));
    expect(block.data.type).toBe('case');
    expect(block.data.tags).toContain('case:nominative');
    expect(block.chain).toBe('cases');

    const content = JSON.parse(block.data.content);
    expect(content.case_type).toBe('nominative');
    expect(content.entity).toBe('agent-alpha');
  });

  it('maintains hash chain integrity across multiple appends', async () => {
    const adapter = new CaseChainAdapter(env);
    const entries: CaseEntry[] = [
      {
        case_type: 'nominative',
        entity: 'agent',
        action: 'start',
        timestamp: new Date().toISOString(),
      },
      {
        case_type: 'instrumental',
        actor: 'agent',
        instrument: 'web-fetch',
        target: 'api.example.com',
      },
      { case_type: 'accusative', subject: 'agent', verb: 'modified', object: 'config.yaml' },
    ];

    const results = [];
    for (const entry of entries) {
      results.push(await adapter.appendCaseEntry(entry));
    }

    expect(results[0]!.index).toBe(1);
    expect(results[1]!.index).toBe(2);
    expect(results[2]!.index).toBe(3);

    // Read blocks and verify prev_hash chain
    const casesDir = join(dataDir, 'chains', 'cases');
    const block1 = JSON.parse(readFileSync(join(casesDir, '000001.json'), 'utf8'));
    const block2 = JSON.parse(readFileSync(join(casesDir, '000002.json'), 'utf8'));
    const block3 = JSON.parse(readFileSync(join(casesDir, '000003.json'), 'utf8'));

    expect(block1.prev_hash).toBe('0'.repeat(64));
    expect(block2.prev_hash).toBe(block1.hash);
    expect(block3.prev_hash).toBe(block2.hash);
  });

  it('queries by case_type', async () => {
    const adapter = new CaseChainAdapter(env);

    await adapter.appendCaseEntry({
      case_type: 'instrumental',
      actor: 'agent',
      instrument: 'grep',
      target: 'src/',
    });
    await adapter.appendCaseEntry({
      case_type: 'locative',
      entity: 'config',
      location: '/etc/memphis',
    });
    await adapter.appendCaseEntry({
      case_type: 'instrumental',
      actor: 'agent',
      instrument: 'curl',
      target: 'api.example.com',
    });

    const result = await adapter.queryCases({ case_type: 'instrumental' });
    expect(result.count).toBe(2);
    expect(result.entries.every((e) => e.case_type === 'instrumental')).toBe(true);
  });

  it('queries by actor field', async () => {
    const adapter = new CaseChainAdapter(env);

    await adapter.appendCaseEntry({
      case_type: 'instrumental',
      actor: 'agent-1',
      instrument: 'grep',
      target: 'src/',
    });
    await adapter.appendCaseEntry({
      case_type: 'instrumental',
      actor: 'agent-2',
      instrument: 'curl',
      target: 'api/',
    });

    const result = await adapter.queryCases({ actor: 'agent-1' });
    expect(result.count).toBe(1);
    expect(result.entries[0]!.actor).toBe('agent-1');
  });

  it('respects query limit', async () => {
    const adapter = new CaseChainAdapter(env);

    for (let i = 0; i < 5; i++) {
      await adapter.appendCaseEntry({
        case_type: 'nominative',
        entity: `entity-${i}`,
        action: 'created',
        timestamp: new Date().toISOString(),
      });
    }

    const result = await adapter.queryCases({ case_type: 'nominative', limit: 2 });
    expect(result.count).toBe(2);
  });

  it('returns most recent entries first', async () => {
    const adapter = new CaseChainAdapter(env);

    await adapter.appendCaseEntry({
      case_type: 'nominative',
      entity: 'first',
      action: 'created',
      timestamp: '2026-01-01T00:00:00Z',
    });
    await adapter.appendCaseEntry({
      case_type: 'nominative',
      entity: 'second',
      action: 'created',
      timestamp: '2026-01-02T00:00:00Z',
    });

    const result = await adapter.queryCases({ case_type: 'nominative' });
    expect(result.entries[0]!.entity).toBe('second');
    expect(result.entries[1]!.entity).toBe('first');
  });

  it('handles all 8 case types', async () => {
    const adapter = new CaseChainAdapter(env);
    const now = new Date().toISOString();

    const entries: CaseEntry[] = [
      { case_type: 'nominative', entity: 'agent', action: 'boot', timestamp: now },
      { case_type: 'genitive', owner: 'agent', possessed: 'memory' },
      { case_type: 'dative', giver: 'user', recipient: 'agent', object: 'task' },
      { case_type: 'accusative', subject: 'agent', verb: 'modified', object: 'file.ts' },
      { case_type: 'instrumental', actor: 'agent', instrument: 'grep', target: 'src/' },
      { case_type: 'locative', entity: 'config', location: '/etc/memphis' },
      { case_type: 'ablative', entity: 'agent', origin: 'idle', destination: 'active' },
      { case_type: 'vocative', invoker: 'user', invocation: 'hey agent', target: 'agent' },
    ];

    for (const entry of entries) {
      const result = await adapter.appendCaseEntry(entry);
      expect(result.success).toBe(true);
      expect(result.case_type).toBe(entry.case_type);
    }

    // Verify each type is queryable
    for (const entry of entries) {
      const result = await adapter.queryCases({ case_type: entry.case_type });
      expect(result.count).toBeGreaterThanOrEqual(1);
    }
  });

  it('handles ablative with optional destination', async () => {
    const adapter = new CaseChainAdapter(env);

    await adapter.appendCaseEntry({
      case_type: 'ablative',
      entity: 'agent',
      origin: 'startup',
    });

    const result = await adapter.queryCases({ case_type: 'ablative' });
    expect(result.count).toBe(1);

    const parsed = JSON.parse(result.entries[0]!.full_json);
    expect(parsed.destination).toBeUndefined();
  });

  it('returns empty result for unmatched query', async () => {
    const adapter = new CaseChainAdapter(env);

    const result = await adapter.queryCases({ case_type: 'vocative' });
    expect(result.count).toBe(0);
    expect(result.entries).toEqual([]);
  });
});
