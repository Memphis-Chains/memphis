import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { CapabilityMatrix } from '../../src/providers/capability-matrix.js';
import { DynamicRouter } from '../../src/providers/dynamic-router.js';
import { resolveModelCapabilitySnapshot } from '../../src/providers/model-capabilities.js';

const catalogRoots: string[] = [];

afterEach(() => {
  for (const root of catalogRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * An account catalog written to disk, as the Codex CLI maintains it.
 */
function accountCatalog(models: unknown[]): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'memphis-capability-catalog-'));
  catalogRoots.push(root);
  mkdirSync(join(root, 'codex-home'), { recursive: true });
  writeFileSync(join(root, 'codex-home', 'models_cache.json'), JSON.stringify({ models }), {
    mode: 0o600,
  });
  return { HOME: root, CODEX_HOME: join(root, 'codex-home') };
}

describe('resolveModelCapabilitySnapshot', () => {
  test('reports MiniMax-M3 as a 1M-context multimodal model', () => {
    expect(resolveModelCapabilitySnapshot('minimax', 'MiniMax-M3')).toMatchObject({
      contextWindowTokens: 1000000,
      supportsStreaming: true,
      supportsVision: true,
      source: 'heuristic',
    });
  });

  test('keeps MiniMax M2-family context at 200k', () => {
    expect(resolveModelCapabilitySnapshot('minimax', 'MiniMax-M2.7')).toMatchObject({
      contextWindowTokens: 200000,
      supportsVision: false,
    });
  });

  // Keep the old Preview id only as a migration compatibility case. The GA
  // configuration and advertised model id are MiniMax-M3.1-Flash.
  test.each([
    'MiniMax-M3.1-Flash',
    'MiniMax-M3.1-Flash-Preview',
    'MiniMax-M3.1',
    'MiniMax-M3.2',
    'minimax-m3.1-highspeed',
    'minimax-m3.1',
  ])('treats the M3 point release %s as part of the 1M M3 family', (model) => {
    expect(resolveModelCapabilitySnapshot('minimax', model)).toMatchObject({
      contextWindowTokens: 1000000,
      supportsVision: true,
    });
  });

  // Same class of bug in the M2 branch: `m2-her` was a separate
  // alternative in the regex, so the family pattern did not cover it
  // and it fell to 32k instead of 200k.
  test.each(['minimax-m2-her', 'MiniMax-M2.1', 'MiniMax-M2.5-highspeed', 'M2'])(
    'treats the M2 variant %s as part of the 200k M2 family',
    (model) => {
      expect(resolveModelCapabilitySnapshot('minimax', model)).toMatchObject({
        contextWindowTokens: 200000,
        supportsVision: false,
      });
    },
  );

  // Widening the family patterns must not turn an unrecognised model
  // into a capable one. The conservative fallback has to stay the
  // default for anything not explicitly a member of M2 or M3.
  test.each(['minimax-some-unreleased-thing', 'm30', 'm3x', 'mm3', 'not-m3'])(
    'keeps the unrecognised model %s on the conservative 32k fallback',
    (model) => {
      expect(resolveModelCapabilitySnapshot('minimax', model)).toMatchObject({
        contextWindowTokens: 32000,
        supportsVision: false,
      });
    },
  );

  test('honours the explicit abab6.5s override ahead of the family patterns', () => {
    expect(resolveModelCapabilitySnapshot('minimax', 'abab6.5s')).toMatchObject({
      contextWindowTokens: 16384,
      supportsVision: false,
    });
  });
});

describe('resolveModelCapabilitySnapshot for the OpenAI Codex family', () => {
  // The catalog is the only source that knows about models released after
  // Memphis was built, and the grant it records is what the server enforces.
  test('narrows the declared window to the grant the account received', () => {
    const rawEnv = accountCatalog([
      {
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1-Sol',
        visibility: 'list',
        context_window: 500000,
        effective_context_window_percent: 95,
      },
      {
        slug: 'gpt-6-astra',
        display_name: 'GPT-6-Astra',
        visibility: 'list',
        context_window: 272000,
        effective_context_window_percent: 95,
      },
    ]);
    // 500000 * 95% = 475000, which is below the documented 1050000 ceiling.
    expect(resolveModelCapabilitySnapshot('openai', 'gpt-6.1-sol', rawEnv)).toMatchObject({
      contextWindowTokens: 475000,
      supportsStreaming: true,
      source: 'heuristic',
    });
    expect(resolveModelCapabilitySnapshot('openai', 'gpt-6.1-sol-max', rawEnv)).toMatchObject({
      contextWindowTokens: 475000,
    });
    expect(resolveModelCapabilitySnapshot('openai', 'gpt-6-astra', rawEnv)).toMatchObject({
      contextWindowTokens: 258400,
    });
  });

  test('falls back to the documented ceiling when no catalog exists', () => {
    const rawEnv = { HOME: '/nonexistent-memphis-home' };
    expect(resolveModelCapabilitySnapshot('openai', 'gpt-6.1-sol', rawEnv)).toMatchObject({
      contextWindowTokens: 1050000,
    });
    // A model Memphis has never heard of gets no window at all.
    expect(
      resolveModelCapabilitySnapshot('openai', 'some-unreleased-model', rawEnv),
    ).toBeUndefined();
  });
});

describe('CapabilityMatrix', () => {
  test('records the M3.1 Flash 512K hard output ceiling', () => {
    const matrix = new CapabilityMatrix();
    const minimax = matrix.getProvider('minimax');
    expect(minimax?.models.find((model) => model.name === 'MiniMax-M3.1-Flash')).toMatchObject({
      contextWindow: 1000000,
      maxOutputTokens: 524288,
      supportsVision: true,
      supportsFunctionCalling: true,
    });
  });

  test('finds provider by requirements', () => {
    const matrix = new CapabilityMatrix();

    const provider = matrix.findBestProvider({
      minContextWindow: 100000,
      needsVision: true,
    });

    expect(provider).toBeDefined();
    expect(provider?.name).toBe('anthropic');
    expect(provider?.models.some((model) => model.supportsVision)).toBe(true);
  });

  test('returns undefined for impossible requirements', () => {
    const matrix = new CapabilityMatrix();

    const provider = matrix.findBestProvider({
      minContextWindow: 10000000,
    });

    expect(provider).toBeUndefined();
  });
});

describe('DynamicRouter', () => {
  test('routes by latency priority', () => {
    const router = new DynamicRouter();

    const result = router.route({
      taskType: 'chat',
      priority: 'latency',
      requirements: {},
    });

    expect(result.provider).toBeDefined();
    expect(result.model).toBeDefined();
    expect(result.reason).toContain('latency');
  });

  test('routes by cost priority', () => {
    const router = new DynamicRouter();

    const result = router.route({
      taskType: 'code',
      priority: 'cost',
      requirements: {},
    });

    expect(result.provider).toBe('ollama');
    expect(result.reason).toContain('cost');
  });

  test('routes with vision requirement', () => {
    const router = new DynamicRouter();

    const result = router.route({
      taskType: 'analysis',
      priority: 'quality',
      requirements: {
        needsVision: true,
      },
    });

    expect(result.provider).toBe('anthropic');
    expect(result.model).toContain('claude');
  });
});
