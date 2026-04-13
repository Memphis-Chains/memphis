import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LLMProvider } from '../../src/core/contracts/llm-provider.js';
import type { ProviderName } from '../../src/core/types.js';
import { performHotReload } from '../../src/infra/config/hot-reload.js';
import {
  clearPostApplyHooks,
  registerPostApplyHook,
} from '../../src/infra/config/post-apply-hooks.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';

function fakeProvider(name: ProviderName): LLMProvider {
  return {
    name,
    defaultModel: () => `${name}-model`,
    listModels: async () => [`${name}-model`],
    health: async () => ({ ok: true, provider: name }),
    generate: async () => ({
      content: 'ok',
      model: `${name}-model`,
      provider: name,
    }),
  } as unknown as LLMProvider;
}

interface TestEnv {
  envDir: string;
  envPath: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setupEnv(initialDefault: ProviderName): TestEnv {
  const envDir = mkdtempSync(join(tmpdir(), 'memphis-cfg-swap-'));
  const envPath = join(envDir, '.env');
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_ENV_FILE = envPath;
  process.env.DEFAULT_PROVIDER = initialDefault;
  writeFileSync(envPath, `DEFAULT_PROVIDER=${initialDefault}\n`, 'utf8');
  return { envDir, envPath, prevEnv };
}

function tearDown(env: TestEnv): void {
  rmSync(env.envDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

describe('hot-reload → DEFAULT_PROVIDER hot-swap end-to-end', () => {
  let env: TestEnv;
  let orchestration: OrchestrationService;

  beforeEach(() => {
    env = setupEnv('anthropic');
    clearPostApplyHooks();
    orchestration = new OrchestrationService({
      defaultProvider: 'anthropic',
      providers: [
        fakeProvider('anthropic'),
        fakeProvider('minimax'),
        fakeProvider('ollama'),
        fakeProvider('local-fallback'),
      ],
    });
    registerPostApplyHook('DEFAULT_PROVIDER', 'orchestration.setDefaultProvider', (ctx) => {
      if (!ctx.nextValue) return;
      orchestration.setDefaultProvider(ctx.nextValue);
    });
  });

  afterEach(() => {
    clearPostApplyHooks();
    tearDown(env);
  });

  it('swaps the live OrchestrationService default after performHotReload', async () => {
    expect(orchestration.getDefaultProvider()).toBe('anthropic');

    writeFileSync(env.envPath, 'DEFAULT_PROVIDER=minimax\n', 'utf8');
    const result = await performHotReload();

    expect(result.ok).toBe(true);
    expect(result.appliedCount).toBeGreaterThanOrEqual(1);
    expect(process.env.DEFAULT_PROVIDER).toBe('minimax');
    expect(orchestration.getDefaultProvider()).toBe('minimax');
    expect(result.hookOutcomes).toEqual([
      { key: 'DEFAULT_PROVIDER', hookName: 'orchestration.setDefaultProvider', ok: true },
    ]);
  });

  it('next resolveProvider("auto") call lands on the swapped default', async () => {
    expect(orchestration.resolveProvider('auto').name).toBe('anthropic');

    writeFileSync(env.envPath, 'DEFAULT_PROVIDER=ollama\n', 'utf8');
    await performHotReload();

    expect(orchestration.resolveProvider('auto').name).toBe('ollama');
  });

  it('records a failed hook outcome when the new value is invalid (provider not registered)', async () => {
    writeFileSync(env.envPath, 'DEFAULT_PROVIDER=shared-llm\n', 'utf8');
    const result = await performHotReload();

    // The env value still applies (shared-llm is in PROVIDER_NAMES so the
    // schema accepts it); the hook is what catches that the provider isn't
    // registered in this runtime and reports the failure.
    expect(process.env.DEFAULT_PROVIDER).toBe('shared-llm');
    expect(orchestration.getDefaultProvider()).toBe('anthropic');
    expect(result.hookOutcomes?.[0]?.ok).toBe(false);
    expect(result.hookOutcomes?.[0]?.error).toMatch(/not registered/);
  });

  it('skips hook firing when DEFAULT_PROVIDER did not change', async () => {
    writeFileSync(env.envPath, 'DEFAULT_PROVIDER=anthropic\n', 'utf8');
    const result = await performHotReload();
    // unchanged → not in `applied` → no hook outcome
    expect(result.hookOutcomes).toBeUndefined();
    expect(orchestration.getDefaultProvider()).toBe('anthropic');
  });
});
