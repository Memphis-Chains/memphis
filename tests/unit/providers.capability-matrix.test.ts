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
