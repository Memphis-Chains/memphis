import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppContainer } from '../../src/app/container.js';
import { createDecision } from '../../src/core/decision-lifecycle.js';
import { createHttpServer } from '../../src/infra/http/server.js';
import { embedReset, embedSearch, embedStore } from '../../src/infra/storage/rust-embed-adapter.js';
import type { AppConfig } from '../../src/infra/config/schema.js';

const REPO_ROOT = '/home/memphis_ai_brain_on_chain/memphis-v4';
const CLI_PATH = `${REPO_ROOT}/src/infra/cli/index.ts`;

function makeTestConfig(dbPath: string): AppConfig {
  return {
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: 0,
    LOG_LEVEL: 'error',
    DEFAULT_PROVIDER: 'local-fallback',
    SHARED_LLM_API_BASE: undefined,
    SHARED_LLM_API_KEY: undefined,
    DECENTRALIZED_LLM_API_BASE: undefined,
    DECENTRALIZED_LLM_API_KEY: undefined,
    LOCAL_FALLBACK_ENABLED: true,
    GEN_TIMEOUT_MS: 30_000,
    GEN_MAX_TOKENS: 512,
    GEN_TEMPERATURE: 0.4,
    RUST_CHAIN_ENABLED: false,
    RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
    DATABASE_URL: `file:${dbPath}`,
  };
}

describe('full workflow e2e', () => {
  it('journal workflow: write entry -> recall -> verify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-e2e-journal-'));
    try {
      const conf = makeTestConfig(join(dir, 'journal.db'));
      const container = createAppContainer(conf);
      const app = createHttpServer(conf, container.orchestration, {
        sessionRepository: container.sessionRepository,
        generationEventRepository: container.generationEventRepository,
      });

      const writeRes = await app.inject({
        method: 'POST',
        url: '/v1/chat/generate',
        payload: {
          input: 'Journal: I fixed E2E workflow plumbing today.',
          provider: 'local-fallback',
          sessionId: 'journal-session-1',
        },
        headers: { 'x-request-id': 'journal-req-1' },
      });
      expect(writeRes.statusCode).toBe(200);

      const recallRes = await app.inject({ method: 'GET', url: '/v1/sessions/journal-session-1/events' });
      expect(recallRes.statusCode).toBe(200);
      const recall = recallRes.json() as {
        sessionId: string;
        events: Array<{ requestId?: string; providerUsed: string }>;
      };
      expect(recall.sessionId).toBe('journal-session-1');
      expect(recall.events.length).toBe(1);
      expect(recall.events[0]?.requestId).toBe('journal-req-1');
      expect(recall.events[0]?.providerUsed).toBe('local-fallback');

      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skip('ask workflow: question -> response -> follow-up with context', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-e2e-ask-'));
    try {
      const baseEnv = `DEFAULT_PROVIDER=local-fallback ASK_SESSIONS_DIR=${dir}`;

      const firstRaw = execSync(
        `${baseEnv} npx tsx ${CLI_PATH} ask --session full-workflow --input "Remember codeword: ORBIT" --json`,
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const first = JSON.parse(firstRaw) as { output: string; session: string };
      expect(first.session).toBe('full-workflow');

      const followRaw = execSync(
        `${baseEnv} npx tsx ${CLI_PATH} ask --session full-workflow --input "What codeword did I just give you?" --json`,
        { encoding: 'utf8', cwd: REPO_ROOT },
      );
      const follow = JSON.parse(followRaw) as { output: string; context: { contextTurns: number } };
      expect(follow.output).toContain('ORBIT');
      expect(follow.context.contextTurns).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skip('decision workflow: propose -> accept -> verify history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-e2e-decision-'));
    try {
      const proposed = createDecision({
        id: 'decision-e2e-1',
        title: 'Adopt deterministic fallback provider',
      });

      const transitionRaw = execSync(
        `npx tsx ${CLI_PATH} decide transition --input '${JSON.stringify(proposed)}' --to accepted --json`,
        { encoding: 'utf8', cwd: dir },
      );
      const transition = JSON.parse(transitionRaw) as {
        to: string;
        decision: { id: string; status: string };
      };
      expect(transition.to).toBe('accepted');
      expect(transition.decision.status).toBe('accepted');

      const historyRaw = execSync(`npx tsx ${CLI_PATH} decide history --id decision-e2e-1 --json`, {
        encoding: 'utf8',
        cwd: dir,
      });
      const history = JSON.parse(historyRaw) as {
        count: number;
        entries: Array<{ decision: { id: string; status: string } }>;
      };
      expect(history.count).toBeGreaterThanOrEqual(1);
      expect(history.entries[0]?.decision.id).toBe('decision-e2e-1');
      expect(history.entries[0]?.decision.status).toBe('accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('embed workflow: store -> search -> verify ranking', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-e2e-embed-'));
    try {
      const bridgePath = join(dir, 'bridge.cjs');
      writeFileSync(
        bridgePath,
        `let rows = [];
module.exports = {
  embed_reset: () => {
    rows = [];
    return JSON.stringify({ ok: true, data: { cleared: true } });
  },
  embed_store: (id, text) => {
    rows.push({ id, text });
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'local-deterministic' } });
  },
  embed_search: (query) => {
    const ranked = rows
      .map((row) => ({
        id: row.id,
        score: row.text.toLowerCase().includes(query.toLowerCase()) ? 0.95 : 0.15,
        text_preview: row.text.slice(0, 40),
      }))
      .sort((a, b) => b.score - a.score);
    return JSON.stringify({ ok: true, data: { query, count: ranked.length, hits: ranked } });
  }
};`,
        'utf8',
      );

      const env = {
        RUST_CHAIN_ENABLED: 'true',
        RUST_CHAIN_BRIDGE_PATH: bridgePath,
      } as NodeJS.ProcessEnv;

      const reset = embedReset(env);
      expect(reset.cleared).toBe(true);

      embedStore('doc-irrelevant', 'This text is about gardening and plants.', env);
      embedStore('doc-target', 'Memphis workflow ranking and retrieval check.', env);

      const result = embedSearch('workflow ranking', 5, env);
      expect(result.count).toBe(2);
      expect(result.hits[0]?.id).toBe('doc-target');
      expect(result.hits[0]?.score).toBeGreaterThan(result.hits[1]?.score ?? 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
