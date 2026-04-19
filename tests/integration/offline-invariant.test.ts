/**
 * Offline-invariant gate (Phase L, closes #149).
 *
 * Memphis must remain operable when the operator has no remote-provider
 * credentials and the network is unreachable. This test enforces that core
 * runtime paths (chain append, runtime-health snapshot) succeed without any
 * remote-provider keys in the environment.
 *
 * Pair with `npm run ops:offline-acceptance:fresh-env` (scripts/rc-drill.sh)
 * for the heavyweight end-to-end acceptance flow. This test is the
 * lightweight PR-time gate — it must stay fast (under a few seconds).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildRuntimeHealthSnapshot } from '../../src/infra/runtime/runtime-health.js';
import { appendBlock, getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';

const REMOTE_PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'GOOGLE_API_KEY',
  'PERPLEXITY_API_KEY',
  'TOGETHER_API_KEY',
  'AIMLAPI_API_KEY',
  'ZAI_API_KEY',
  'MINIMAX_API_KEY',
  'RUST_EMBED_PROVIDER_URL',
  'RUST_EMBED_PROVIDER_API_KEY',
] as const;

describe('offline-invariant gate (Phase L)', () => {
  let tmpDataDir: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'memphis-offline-invariant-'));
    for (const key of REMOTE_PROVIDER_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('chain append succeeds with no remote-provider keys in env', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MEMPHIS_DATA_DIR: tmpDataDir,
      RUST_CHAIN_ENABLED: 'true',
    };
    const status = getChainAdapterStatus(env);
    if (!status.rustBridgeLoaded) {
      console.warn(
        'Rust bridge not loaded — skipping offline-invariant chain-append assertion',
      );
      return;
    }

    const result = await appendBlock(
      'journal',
      {
        content: 'offline-invariant gate — chain append must work without remote API keys',
        tags: ['ci', 'offline-invariant'],
        source: 'test',
      },
      env,
    );

    expect(result.index).toBeGreaterThanOrEqual(0);
    expect(result.hash).toBeTruthy();
    expect(result.chain).toBe('journal');
  });

  it('runtime-health offline mode is local-first and ready when no remote provider configured', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MEMPHIS_DATA_DIR: tmpDataDir,
    };
    const config = {
      DATABASE_URL: `file:${join(tmpDataDir, 'offline-invariant.db')}`,
      DEFAULT_PROVIDER: 'local-fallback' as const,
      LOCAL_FALLBACK_ENABLED: true,
    } as Parameters<typeof buildRuntimeHealthSnapshot>[0];

    const snapshot = await buildRuntimeHealthSnapshot(config, env);

    expect(snapshot.offline.localFallbackEnabled).toBe(true);
    expect(snapshot.offline.ready).toBe(true);
    expect(snapshot.offline.supportedModes).toContain('local-fallback');
    // The active mode must NOT fall back to 'remote' when no remote provider
    // keys are present in the environment. Either 'local-fallback' or
    // 'ollama-local' is acceptable.
    expect(snapshot.offline.activeMode).not.toBe('remote');
  });
});
