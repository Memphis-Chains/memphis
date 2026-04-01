import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchExactMemory } from '../../src/infra/memory/exact-search.js';
import { repairRuntimeState } from '../../src/infra/runtime/runtime-repair.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteGenerationEventRepository } from '../../src/infra/storage/sqlite/repositories/generation-event-repository.js';
import { SqliteOperatorChatSessionRepository } from '../../src/infra/storage/sqlite/repositories/operator-chat-session-repository.js';

function writeChainBlock(
  runtimeDir: string,
  chain: string,
  index: number,
  data: Record<string, unknown>,
): void {
  const hash = index.toString(16).padStart(64, '0');
  const prevHash = index === 1 ? '0'.repeat(64) : (index - 1).toString(16).padStart(64, '0');
  const chainDir = join(runtimeDir, 'chains', chain);
  mkdirSync(chainDir, { recursive: true });
  writeFileSync(
    join(chainDir, `${String(index).padStart(6, '0')}.json`),
    JSON.stringify(
      {
        index,
        timestamp: new Date(Date.UTC(2026, 2, 28, 12, 0, index)).toISOString(),
        chain,
        data,
        prev_hash: prevHash,
        hash,
      },
      null,
      2,
    ),
    'utf8',
  );
}

describe('runtime repair', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds exact-search from canonical chain truth', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-repair-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'state', 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    writeChainBlock(runtimeDir, 'journal', 1, {
      type: 'journal',
      content: 'Repair should rebuild the exact search index from chain truth',
      tags: ['repair', 'search'],
    });

    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(result.after.exactSearch.status).toBe('indexed');
    expect(result.after.repair.status).toBe('healthy');
    expect(result.applied.some((item) => item.includes('rebuilt exact-search index'))).toBe(true);

    const hit = searchExactMemory('rebuild the exact search index', 5, env);
    expect(hit.count).toBe(1);
    expect(hit.hits[0]?.chain).toBe('journal');
  });

  it('rebuilds degraded patterns lane from canonical decisions', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-patterns-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'memphis.db')}`,
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    for (const [index, content] of [
      'Stabilize API rollout for local runtime',
      'Stabilize API rollout for offline runtime',
      'Stabilize API rollout for operator runtime',
    ].entries()) {
      writeChainBlock(runtimeDir, 'decisions', index + 1, {
        type: 'decision',
        content,
        tags: ['api', 'stability'],
      });
    }

    const patternsDir = join(runtimeDir, 'chains', 'patterns');
    mkdirSync(patternsDir, { recursive: true });
    writeFileSync(join(patternsDir, '000001.json'), '{ bad json', 'utf8');
    writeFileSync(join(runtimeDir, 'patterns.json'), '{ bad json', 'utf8');

    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(result.after.cognition.persistenceStatus).toBe('ready');
    expect(result.after.repair.status).toBe('healthy');
    expect(result.applied.some((item) => item.includes('rebuilt derived pattern state'))).toBe(
      true,
    );
    expect(existsSync(join(runtimeDir, 'patterns.json'))).toBe(false);
    expect(result.after.cognition.patternsChain.entries).toBeGreaterThan(0);
  });

  it('normalizes legacy conversation sessions into the canonical operator conversation', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-runtime-sessions-'));
    tempDirs.push(runtimeDir);
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_DATA_DIR: runtimeDir,
      DATABASE_URL: `file:${join(runtimeDir, 'state', 'memphis.db')}`,
      MEMPHIS_PRIMARY_ACTOR_ID: 'operator:local',
      MEMPHIS_ACTOR_ALIASES_JSON: JSON.stringify({
        'telegram:7': 'operator:local',
      }),
      RUST_CHAIN_ENABLED: 'false',
      LOCAL_FALLBACK_ENABLED: 'true',
    };

    const db = createSqliteClient(env.DATABASE_URL);
    runMigrations(db);

    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(db);
      const generationRepo = new SqliteGenerationEventRepository(db);

      operatorRepo.appendMessages('rust-tui-default', [
        { role: 'user', content: 'legacy tui user', provider: 'tui' },
        { role: 'assistant', content: 'legacy tui assistant', provider: 'tui' },
      ]);
      operatorRepo.appendMessages('primary::telegram:7', [
        { role: 'user', content: 'telegram user', provider: 'telegram' },
        { role: 'assistant', content: 'telegram assistant', provider: 'telegram' },
      ]);
      generationRepo.create({
        id: 'gen-legacy-1',
        sessionId: 'rust-tui-default',
        providerUsed: 'ollama',
        modelUsed: 'qwen2.5-coder:3b',
        timingMs: 15,
        requestId: 'req-legacy-1',
      });
      db.prepare(
        `UPDATE operator_chat_messages
         SET created_at = CASE
           WHEN session_id = 'rust-tui-default' AND sequence = 1 THEN '2026-04-01T10:00:01.000Z'
           WHEN session_id = 'rust-tui-default' AND sequence = 2 THEN '2026-04-01T10:00:02.000Z'
           WHEN session_id = 'primary::telegram:7' AND sequence = 1 THEN '2026-04-01T10:00:03.000Z'
           WHEN session_id = 'primary::telegram:7' AND sequence = 2 THEN '2026-04-01T10:00:04.000Z'
           ELSE created_at
         END`,
      ).run();
      db.prepare(
        `UPDATE sessions
         SET created_at = CASE
           WHEN id = 'rust-tui-default' THEN '2026-04-01T10:00:01.000Z'
           WHEN id = 'primary::telegram:7' THEN '2026-04-01T10:00:03.000Z'
           ELSE created_at
         END,
         updated_at = CASE
           WHEN id = 'rust-tui-default' THEN '2026-04-01T10:00:02.000Z'
           WHEN id = 'primary::telegram:7' THEN '2026-04-01T10:00:04.000Z'
           ELSE updated_at
         END`,
      ).run();
    } finally {
      db.close();
    }

    const result = await repairRuntimeState({ rawEnv: env });

    expect(result.ok).toBe(true);
    expect(
      result.applied.some((item) =>
        item.includes('normalized conversation session rust-tui-default -> primary::operator:local'),
      ),
    ).toBe(true);
    expect(
      result.applied.some((item) =>
        item.includes(
          'normalized conversation session primary::telegram:7 -> primary::operator:local',
        ),
      ),
    ).toBe(true);

    const verifyDb = createSqliteClient(env.DATABASE_URL);
    try {
      const operatorRepo = new SqliteOperatorChatSessionRepository(verifyDb);
      const generationRepo = new SqliteGenerationEventRepository(verifyDb);

      const canonicalMessages = operatorRepo.listMessages('primary::operator:local', 10);
      expect(canonicalMessages.map((message) => message.content)).toEqual([
        'legacy tui user',
        'legacy tui assistant',
        'telegram user',
        'telegram assistant',
      ]);
      expect(operatorRepo.listMessages('rust-tui-default', 10)).toEqual([]);
      expect(operatorRepo.listMessages('primary::telegram:7', 10)).toEqual([]);
      expect(generationRepo.listBySession('primary::operator:local')).toHaveLength(1);
      expect(generationRepo.listBySession('rust-tui-default')).toEqual([]);
    } finally {
      verifyDb.close();
    }
  });
});
