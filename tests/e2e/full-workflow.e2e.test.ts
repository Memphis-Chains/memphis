import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const cliPath = resolve(repoRoot, 'src/infra/cli/index.ts');

function runCli(command: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  return execSync(`npx tsx ${cliPath} ${command}`, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DEFAULT_PROVIDER: 'local-fallback',
      ...env,
    },
  });
}

describe('full workflow e2e', () => {
  it('ask -> recall via session in temp dir', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-ask-'));

    const ask1 = JSON.parse(
      runCli('ask --session e2e --input "remember token alpha" --provider local-fallback --json', workDir),
    );
    expect(ask1.session).toBe('e2e');

    const ask2 = JSON.parse(
      runCli('ask --session e2e --input "/context" --provider local-fallback --json', workDir),
    );
    expect(ask2.mode).toBe('ask-session-context');
    expect(ask2.turns).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('embed -> search via local bridge in temp dir', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-embed-'));
    const bridgePath = join(workDir, 'bridge.cjs');
    writeFileSync(
      bridgePath,
      `let rows = [];
module.exports = {
  embed_reset: () => JSON.stringify({ ok: true, data: { cleared: true } }),
  embed_store: (id, text) => {
    rows.push({ id, text });
    return JSON.stringify({ ok: true, data: { id, count: rows.length, dim: 32, provider: 'test' } });
  },
  embed_search: (query) => {
    const hit = rows.find((r) => r.text.includes(query)) || rows[0] || { id: 'doc-1', text: 'deterministic test' };
    return JSON.stringify({ ok: true, data: { query, count: 1, hits: [{ id: hit.id, score: 0.9, text_preview: hit.text.slice(0, 20) }] } });
  }
};`,
      'utf8',
    );

    const env = {
      RUST_CHAIN_ENABLED: 'true',
      RUST_CHAIN_BRIDGE_PATH: bridgePath,
      EMBED_CACHE_TTL_SECONDS: '30',
    } as NodeJS.ProcessEnv;

    const store = JSON.parse(runCli('embed store --id doc-1 --value "deterministic test" --json', workDir, env));
    expect(store.ok).toBe(true);

    const search = JSON.parse(runCli('embed search --query deterministic --top-k 3 --json', workDir, env));
    expect(search.ok).toBe(true);
    expect(search.data.hits[0].id).toBe('doc-1');
  }, 20000);

  it('decision -> history flow works in temp dir', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mv4-e2e-decision-'));
    const inferred = JSON.parse(runCli('infer --input "we should adopt feature flags" --json', workDir));
    expect(inferred.ok).toBe(true);

    const history = JSON.parse(runCli('decide history --latest 5 --json', workDir));
    expect(history.ok).toBe(true);
    expect(Array.isArray(history.entries)).toBe(true);
  }, 20000);
});
