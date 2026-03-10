import { describe, expect, test } from 'vitest';
import { CapabilityMatrix } from '../../src/providers/capability-matrix.js';
import { DynamicRouter } from '../../src/providers/dynamic-router.js';

describe('CapabilityMatrix', () => {
  test('finds provider by requirements', () => {
    const matrix = new CapabilityMatrix();

    const provider = matrix.findBestProvider({
      minContextWindow: 100000,
      needsVision: true,
    });

    expect(provider).toBeDefined();
    expect(provider?.name).toBe('openai-compatible');
    expect(provider?.models.some((model) => model.name === 'gpt-4-turbo')).toBe(true);
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

    expect(result.provider).toBe('openai-compatible');
    expect(result.model).toContain('gpt-4');
  });
});
