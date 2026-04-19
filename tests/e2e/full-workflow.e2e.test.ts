import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../helpers/cli.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isOperatorConfigured: vi.fn(() => true),
  isSessionAuthorized: vi.fn(() => true),
  authorizeSession: vi.fn(),
  validateOperatorPassphrase: vi.fn(() => true),
  isGatedOperation: vi.fn(() => false),
  requireOperatorAuth: vi.fn(async () => true),
}));

function writeRuntimeBridge(workDir: string): string {
  const bridgePath = join(workDir, 'bridge.cjs');
  writeFileSync(
    bridgePath,
    `let rows = [];
module.exports = {
  chain_append: (chainJson, blockJson) => {
    const chain = JSON.parse(chainJson);
    const block = JSON.parse(blockJson);
    return JSON.stringify({ ok: true, data: { appended: true, length: chain.length + 1, chain: [...chain, block] } });
  },
  chain_validate: () => JSON.stringify({ ok: true, data: { valid: true, errors: [] } }),
  chain_query: (chainJson, contains, tag) => {
    const chain = JSON.parse(chainJson);
    const blocks = chain.filter((block) => {
      const content = String(block?.data?.content ?? '');
      const tags = Array.isArray(block?.data?.tags) ? block.data.tags : [];
      return (!contains || content.includes(contains)) && (!tag || tags.includes(tag));
    });
    return JSON.stringify({ ok: true, data: { count: blocks.length, blocks } });
  },
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: (id, text) => {
    rows = rows.filter((row) => row.id !== id);
    rows.push({ id, text });
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'test-bridge' } });
  },
  embed_search: (query, topK = 5) => {
    const hits = rows
      .filter((row) => row.text.toLowerCase().includes(String(query).toLowerCase()))
      .slice(0, topK)
      .map((row, index) => ({ id: row.id, score: 0.99 - index * 0.01, text_preview: row.text.slice(0, 80) }));
    return JSON.stringify({ ok: true, data: { query, count: hits.length, hits } });
  },
  vaultInitFull: (passphrase, question) => ({
    vault: { salt: Buffer.from('salt-salt-salt-1234'), master_key: Buffer.from(passphrase.padEnd(32, '!').slice(0, 32)) },
    did: 'did:memphis:test-smoke',
    qa_question: question,
  }),
  vaultStore: (_vault, key, plaintext) => ({
    id: 'entry-' + key,
    key,
    ciphertext: Buffer.from(plaintext),
    nonce: Buffer.from('nonce-123456789012'),
    tag: Buffer.from('tag-123456789012'),
    createdAt: new Date().toISOString(),
  }),
  vaultRetrieve: (_vault, entry) => Buffer.from(entry.ciphertext),
};`,
    'utf8',
  );
  return bridgePath;
}

function parseCliJson<T>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const start = trimmed.lastIndexOf('\n{');
    const candidate = start >= 0 ? trimmed.slice(start + 1) : trimmed.slice(trimmed.indexOf('{'));
    return JSON.parse(candidate) as T;
  }
}

describe('full workflow e2e', () => {
  it('runs the canonical solo-local CLI flow in a temp workspace', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv5-e2e-solo-'));
    const bridgePath = writeRuntimeBridge(workDir);
    const env = {
      DEFAULT_PROVIDER: 'local-fallback',
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_VAULT_PEPPER: 'memphis-0123456789abcdef0123456789abcdef',
      MEMPHIS_DATA_DIR: join(workDir, '.memphis'),
      MEMPHIS_VAULT_STATE_PATH: join(workDir, 'data', 'vault-state.json'),
      MEMPHIS_AGENT_NAME: 'Memphis Agent',
      MEMPHIS_OWNER_NAME: 'local operator',
    };

    const bootstrap = parseCliJson<{ ok: boolean }>(
      await runCli(
        [
          'onboarding',
          'wizard',
          '--write',
          '--profile',
          'dev-local',
          '--out',
          '.env',
          '--force',
          '--json',
        ],
        {
          cwd: workDir,
          env,
        },
      ),
    );
    expect(bootstrap.ok).toBe(true);

    const vault = parseCliJson<{ ok: boolean }>(
      await runCli(
        [
          'vault',
          'init',
          '--passphrase',
          'StrongPassphrase!123',
          '--recovery-question',
          'pet',
          '--recovery-answer',
          'nori',
          '--json',
        ],
        { cwd: workDir, env },
      ),
    );
    expect(vault.ok).toBe(true);

    const store = parseCliJson<{ ok: boolean; data: { memoryId: string } }>(
      await runCli(
        ['embed', 'store', '--id', 'guest-quiet', '--value', 'guest prefers quiet room', '--json'],
        {
          cwd: workDir,
          env,
        },
      ),
    );
    expect(store.ok).toBe(true);
    expect(store.data.memoryId).toBeTruthy();

    const search = parseCliJson<{ ok: boolean; data: { hits: Array<{ id: string }> } }>(
      await runCli(['embed', 'search', '--query', 'quiet room', '--top-k', '5', '--json'], {
        cwd: workDir,
        env,
      }),
    );
    expect(search.ok).toBe(true);
    expect(search.data.hits[0]?.id).toBe(store.data.memoryId);

    const guide = parseCliJson<{
      agentName: string;
      sections: Array<{ title: string; lines: string[] }>;
    }>(await runCli(['guide', '--json'], { cwd: workDir, env }));
    expect(guide.agentName).toBe('Memphis Agent');
    expect(Array.isArray(guide.sections)).toBe(true);
    expect(
      guide.sections.some(
        (section: { title: string; lines: string[] }) =>
          section.title === 'Tools' &&
          section.lines.some((line) => line.includes('memphis_recall')),
      ),
    ).toBe(true);

    const chat = parseCliJson<{ providerUsed: string; output: string }>(
      await runCli(['chat', '--input', 'acceptance smoke chat', '--json'], {
        cwd: workDir,
        env: {
          ...env,
          DEFAULT_PROVIDER: 'local-fallback',
        },
      }),
    );
    expect(chat.providerUsed).toBe('local-fallback');
    expect(chat.output).toContain('acceptance smoke chat');
  }, 20000);

  it('ask -> recall via session in temp dir', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-ask-'));
    const env = { DEFAULT_PROVIDER: 'local-fallback' };

    const ask1 = parseCliJson<{ session: string }>(
      await runCli(
        [
          'ask',
          '--session',
          'e2e',
          '--input',
          'remember token alpha',
          '--provider',
          'local-fallback',
          '--json',
        ],
        { cwd: workDir, env },
      ),
    );
    expect(ask1.session).toBe('e2e');

    const ask2 = parseCliJson<{ mode: string; turns: number }>(
      await runCli(
        [
          'ask',
          '--session',
          'e2e',
          '--input',
          '/context',
          '--provider',
          'local-fallback',
          '--json',
        ],
        { cwd: workDir, env },
      ),
    );
    expect(ask2.mode).toBe('ask-session-context');
    expect(ask2.turns).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('embed -> search via local bridge in temp dir', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-embed-'));
    const bridgePath = writeRuntimeBridge(workDir);

    const env = {
      DEFAULT_PROVIDER: 'local-fallback',
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      MEMPHIS_DATA_DIR: join(workDir, '.memphis'),
      EMBED_CACHE_TTL_SECONDS: '30',
    };

    const store = parseCliJson<{ ok: boolean }>(
      await runCli(['embed', 'store', '--id', 'doc-1', '--value', 'deterministic test', '--json'], {
        cwd: workDir,
        env,
      }),
    );
    expect(store.ok).toBe(true);

    const search = parseCliJson<{ ok: boolean; data: { hits: Array<{ id: string }> } }>(
      await runCli(['embed', 'search', '--query', 'deterministic', '--top-k', '3', '--json'], {
        cwd: workDir,
        env,
      }),
    );
    expect(search.ok).toBe(true);
    expect(search.data.hits[0].id).toBe('doc-1');
  }, 20000);

  it('decision transition -> chain history -> exact lookup works in temp dir', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-decision-'));
    const env = {
      DEFAULT_PROVIDER: 'local-fallback',
      MEMPHIS_DATA_DIR: join(workDir, '.memphis'),
    };
    const record = {
      id: 'decision-e2e-1',
      title: 'Prefer local chain truth',
      context: 'offline acceptance proof',
      options: ['chain-first'],
      chosen: 'chain-first',
      confidence: 0.85,
      status: 'proposed',
      schemaVersion: 1,
      createdAt: '2026-03-28T10:00:00.000Z',
      updatedAt: '2026-03-28T10:00:00.000Z',
    };

    const transition = parseCliJson<{
      ok: boolean;
      mode: string;
      decision: { status: string };
      decisionChainRef?: { chain: string };
    }>(
      await runCli(
        ['decide', 'transition', '--input', JSON.stringify(record), '--to', 'accepted', '--json'],
        { cwd: workDir, env },
      ),
    );
    expect(transition.ok).toBe(true);
    expect(transition.mode).toBe('decide-transition');
    expect(transition.decision.status).toBe('accepted');
    expect(transition.decisionChainRef?.chain).toBe('decisions');

    const history = parseCliJson<{
      ok: boolean;
      count: number;
      entries: Array<{ decision: { status: string }; chainRef?: { chain: string } }>;
    }>(
      await runCli(['decide', 'history', '--id', 'decision-e2e-1', '--json'], {
        cwd: workDir,
        env,
      }),
    );
    expect(history.ok).toBe(true);
    expect(history.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(history.entries)).toBe(true);
    expect(history.entries.at(-1)?.decision.status).toBe('accepted');
    expect(history.entries.at(-1)?.chainRef?.chain).toBe('decisions');

    const search = parseCliJson<{ ok: boolean; data: { results: Array<{ chain: string }> } }>(
      await runCli(
        ['search', '--query', 'Prefer local chain truth', '--chain', 'decisions', '--json'],
        { cwd: workDir, env },
      ),
    );
    expect(search.ok).toBe(true);
    expect(search.data.results[0]?.chain).toBe('decisions');

    const prediction = parseCliJson<{ ok: boolean; mode: string }>(
      await runCli(['predict', '--json'], { cwd: workDir, env }),
    );
    expect(prediction.ok).toBe(true);
    expect(prediction.mode).toBe('predict-chain');
  }, 20000);
});
