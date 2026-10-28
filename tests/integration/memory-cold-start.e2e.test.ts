import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
type WorkerOutput = {
  pid: number;
  result: {
    success?: boolean;
    hash?: string;
    persistence?: { memoryStored: boolean; memoryStoreAttempted: boolean; policyBlocks: string[] };
  };
  recall?: {
    mode: string;
    results: Array<{ content: string; sourceKey?: string; sourceHash?: string }>;
  };
  blocks?: Array<{ hash: string; data: { content: string } }>;
  verify?: { ok: boolean };
  exact?: { count: number; hits: Array<{ blockHash: string }> };
  captured?: Array<{ systemPrompt: string }>;
  beforeCount?: number;
  afterCount?: number;
};

function runtime() {
  const root = mkdtempSync(join(tmpdir(), 'memphis-cold-start-e2e-'));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@memphis-chains/memphis' }));
  writeFileSync(join(root, 'fixture.env'), '', { mode: 0o600 });
  const pids = new Set<number>();
  return {
    pids,
    run(input: Record<string, unknown>): WorkerOutput {
      const env: Record<string, string> = {
        HOME: root,
        TMPDIR: tmpdir(),
        USER: 'cold-start-fixture',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        LANG: 'C.UTF-8',
        NODE_ENV: 'test',
        VITEST: 'true',
        MEMPHIS_RUNTIME_ROOT: root,
        MEMPHIS_ENV_FILE: join(root, 'fixture.env'),
        MEMPHIS_HOME: data,
        MEMPHIS_DATA_DIR: data,
        DATABASE_URL: `file:${join(data, 'memory.db')}`,
        RUST_CHAIN_ENABLED: 'true',
        RUST_CHAIN_BRIDGE_PATH:
          process.env.MEMPHIS_TEST_NATIVE_BRIDGE ?? join(repo, 'crates/memphis-napi'),
        RUST_EMBED_MODE: 'local',
        RUST_EMBED_DIM: '32',
        RUST_EMBED_PERSIST_ENABLED: 'true',
        RUST_EMBED_PERSIST_PATH: join(data, 'embed-index.json'),
        MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
        MEMPHIS_SECURITY_AUDIT_LOG_PATH: join(data, 'audit.jsonl'),
        MEMPHIS_LOG_FILE: join(data, 'runtime.log'),
        MEMPHIS_QUEUE_WAL_PATH: join(data, 'queue.wal'),
        MEMPHIS_SURFACE_CLI_CHAT_ALLOW_COGNITIVE_PRELUDE: 'false',
        MEMPHIS_SURFACE_CLI_CHAT_ALLOW_URL_FETCH: 'false',
        MEMPHIS_SURFACE_CLI_CHAT_ALLOW_MEMORY_WRITE: 'false',
        MEMPHIS_SURFACE_CLI_CHAT_DEFAULT_CONSENT: 'local-only',
        LOG_LEVEL: 'error',
      };
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          join(repo, 'node_modules/tsx/dist/loader.mjs'),
          join(repo, 'tests/fixtures/memory-cold-start-worker.mjs'),
        ],
        {
          cwd: root,
          env,
          timeout: 30_000,
          encoding: 'utf8',
          input: JSON.stringify({
            runtime: root,
            moduleRoot: join(repo, 'src'),
            user: 'acceptance-user',
            ...input,
          }),
        },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      const line = child.stdout
        .split('\n')
        .find((item) => item.startsWith('MEMORY_ACCEPTANCE_RESULT='));
      expect(line).toBeDefined();
      const result = JSON.parse(line!.slice('MEMORY_ACCEPTANCE_RESULT='.length)) as WorkerOutput;
      expect(pids.has(result.pid)).toBe(false);
      pids.add(result.pid);
      return result;
    },
  };
}

describe('native durable memory across fresh processes', () => {
  it('keeps source history and supplies corrections beyond both old preview limits after a model change', () => {
    const fixture = runtime();
    const first = fixture.run({
      action: 'write',
      content: '[acceptance-user] AtlasMem review code: MON.',
    });
    const cold = fixture.run({ action: 'inspect', query: 'AtlasMem' });
    expect(cold.verify?.ok).toBe(true);
    expect(cold.exact?.hits[0]?.blockHash).toBe(first.result.hash);

    const correction =
      '[acceptance-user] AtlasMem correction: ' +
      'Background information. '.repeat(20) +
      'The previous MON code is superseded. Current review code: TUE.';
    const corrected = fixture.run({ action: 'write', content: correction });
    const history = fixture.run({ action: 'inspect', query: 'AtlasMem' });
    expect(history.blocks?.map((block) => block.hash)).toEqual([
      first.result.hash,
      corrected.result.hash,
    ]);
    expect(
      history.recall?.results.some(
        (hit) => hit.content === correction && hit.sourceHash === corrected.result.hash,
      ),
    ).toBe(true);
    expect(history.verify?.ok).toBe(true);
    fixture.run({ action: 'write', content: '[other-user] AtlasMem current code: FRI.' });

    // Scripted provider replies keep CI offline. The assertions inspect what
    // each newly selected model actually receives, not the scripted answer.
    for (const model of ['provider-control-a', 'provider-control-b']) {
      const turn = fixture.run({
        action: 'turn',
        model,
        stubReply: 'TUE',
        query: 'AtlasMem: what is my current review code?',
      });
      const prompt = turn.captured?.[0]?.systemPrompt ?? '';
      expect(prompt).toContain(correction);
      expect(prompt).not.toContain('[other-user]');
      expect(turn.result.persistence?.memoryStored).toBe(false);
      expect(turn.verify?.ok).toBe(true);
    }
    expect(fixture.pids.size).toBe(7);
  }, 60_000);

  it('returns no memory before a write and honors a conversation write denial after restart', () => {
    const fixture = runtime();
    const empty = fixture.run({ action: 'inspect', query: 'UnknownFixtureSubject' });
    expect(empty.recall).toMatchObject({ mode: 'none', results: [] });
    fixture.run({ action: 'write', content: '[acceptance-user] AtlasMem known fact.' });
    const turn = fixture.run({
      action: 'turn',
      model: 'provider-control',
      stubReply: 'Read only.',
      query: 'DenyMarkerAlfa: this conversation has memory writes disabled.',
    });
    expect(turn.beforeCount).toBe(turn.afterCount);
    expect(turn.result.persistence).toMatchObject({
      memoryStored: false,
      memoryStoreAttempted: false,
    });
    expect(turn.result.persistence?.policyBlocks).toContain('memory_store_surface_policy_blocked');
    const final = fixture.run({ action: 'inspect', query: 'DenyMarkerAlfa' });
    expect(final.blocks?.some((block) => block.data.content.includes('DenyMarkerAlfa'))).toBe(
      false,
    );
    expect(final.verify?.ok).toBe(true);
  }, 60_000);
});
