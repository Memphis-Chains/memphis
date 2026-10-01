import { describe, expect, test } from 'vitest';

import { CapabilityMatrix } from '../../src/providers/capability-matrix.js';
import { DynamicRouter } from '../../src/providers/dynamic-router.js';
import { resolveModelCapabilitySnapshot } from '../../src/providers/model-capabilities.js';

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

  // 2026-10-01 regression. The M3 branch was `/^(minimax-)?m3$/i`,
  // anchored at both ends, so it matched the bare name only. The
  // operator's configured model is `MiniMax-M3.1-Flash-Preview`, which
  // fell through to the 32k catch-all and reported `supportsVision:
  // false` — a 31x understatement of the window on the model actually
  // in use. The two tests above both passed the whole time.
  test.each([
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

describe('CapabilityMatrix', () => {
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
