import { describe, expect, test } from 'vitest';

import type { IStore } from '../../src/cognitive/store.js';
import { DecisionLifecycle } from '../../src/decision/lifecycle.js';
import { DecisionValidator } from '../../src/decision/validator.js';

/** In-memory store mock for testing — avoids touching real chain on disk */
function createMockStore(): IStore {
  const store: Array<{ chain: string; data: Record<string, unknown> }> = [];
  return {
    async append(chain: string, data: Record<string, unknown>) {
      store.push({ chain, data });
      return {
        index: store.filter((s) => s.chain === chain).length - 1,
        hash: 'mock-hash',
        chain,
        timestamp: new Date().toISOString(),
      };
    },
  };
}

describe('DecisionLifecycle', () => {
  test('creates decision with proper hash', async () => {
    const lifecycle = new DecisionLifecycle(createMockStore());

    const decision = await lifecycle.create({
      question: 'Which framework to use?',
      choice: 'React',
      reasoning: 'Large ecosystem and community support',
      tags: ['frontend', 'framework'],
    });

    expect(decision.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(decision.timestamp).toBeDefined();
    expect(decision.chainRef).toBeDefined();
  });

  test('prevents duplicate decisions', async () => {
    const lifecycle = new DecisionLifecycle(createMockStore());

    await lifecycle.create({
      question: 'Test question',
      choice: 'Test choice',
      reasoning: 'Test reasoning long enough',
    });

    await expect(
      lifecycle.create({
        question: 'Test question',
        choice: 'Test choice',
        reasoning: 'Test reasoning long enough',
      }),
    ).rejects.toThrow('Duplicate decision');
  });

  test('validates before chain append', () => {
    const validator = new DecisionValidator();
    const invalidDecision = {
      question: '',
      choice: 'Test',
      reasoning: 'Test',
      hash: 'invalid',
      timestamp: new Date().toISOString(),
    };

    expect(() => validator.validateForChain(invalidDecision)).toThrow();
  });
});
