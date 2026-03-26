import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SUPPORTED_DURABLE_BLOCK_TYPES,
  assertDurableBlockPayload,
} from '../../src/cognitive/durable-write.js';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import { ModelC_PredictivePatterns } from '../../src/cognitive/model-c.js';
import { ModelD_CollectiveCoordination } from '../../src/cognitive/model-d.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';
import { ProactiveAssistant } from '../../src/cognitive/proactive-assistant.js';
import type { IStore } from '../../src/cognitive/store.js';
import type { AgentConfig } from '../../src/cognitive/types.js';
import type { Block } from '../../src/memory/chain.js';

function createStore(): { store: IStore; append: ReturnType<typeof vi.fn> } {
  const append = vi.fn().mockResolvedValue({
    index: 1,
    hash: 'hash-1',
    chain: 'journal',
    timestamp: new Date().toISOString(),
  });

  return {
    store: { append },
    append,
  };
}

function block(
  timestamp: string,
  chain: string,
  content: string,
  tags: string[] = [],
  type: string = 'journal',
): Block {
  return {
    timestamp,
    chain,
    data: {
      type,
      content,
      tags,
    },
  };
}

async function flushAsyncPersistence(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('durable write contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts only the supported durable block types', () => {
    expect(SUPPORTED_DURABLE_BLOCK_TYPES).toEqual([
      'insight',
      'decision',
      'system_event',
      'journal',
      'error',
      'case',
    ]);

    expect(() =>
      assertDurableBlockPayload({
        type: 'insight',
        content: 'Saved summary',
        tags: ['insight'],
      }),
    ).not.toThrow();

    expect(() =>
      assertDurableBlockPayload({
        type: 'reflection',
        content: 'Should fail',
        tags: ['bad'],
      }),
    ).toThrow(/Unsupported durable block type/);
  });

  it('persists model-c patterns as insight blocks with summary content', async () => {
    const { store, append } = createStore();
    const blocks = [
      block('2026-03-10T10:00:00.000Z', 'decision', 'Build release pipeline stability', [
        'release',
        'pipeline',
      ], 'decision'),
      block('2026-03-10T10:01:00.000Z', 'decision', 'Build release pipeline reliability', [
        'release',
        'pipeline',
      ], 'decision'),
      block('2026-03-10T10:02:00.000Z', 'decision', 'Build release pipeline checks', [
        'release',
        'pipeline',
      ], 'decision'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3 }, store);
    await model.learn();

    expect(append).toHaveBeenCalledWith(
      'patterns',
      expect.objectContaining({
        type: 'insight',
        kind: 'pattern',
        content: expect.stringContaining('Pattern'),
        tags: expect.arrayContaining(['model-c', 'pattern']),
      }),
    );
  });

  it('persists model-e reflections as insight blocks with summary content', async () => {
    const { store, append } = createStore();
    const model = new ModelE_MetaCognitiveReflection(
      [
        block('2026-03-10T10:00:00.000Z', 'journal', 'Investigated roadmap cleanup', [
          'roadmap',
        ]),
        block('2026-03-10T10:05:00.000Z', 'decision', 'Decided on hardening-first release path', [
          'release',
        ], 'decision'),
      ],
      undefined,
      store,
    );

    model.daily();
    await flushAsyncPersistence();

    expect(append).toHaveBeenCalledWith(
      'reflections',
      expect.objectContaining({
        type: 'insight',
        kind: 'reflection',
        content: expect.stringContaining('daily reflection'),
        tags: expect.arrayContaining(['model-e', 'reflection', 'daily']),
      }),
    );
  });

  it('persists proactive assistant messages as system events', async () => {
    const { store, append } = createStore();
    const generateSpy = vi.spyOn(InsightGenerator.prototype, 'generate').mockResolvedValue({
      generated: new Date('2026-03-10T10:00:00.000Z'),
      mood: 'productive',
      summary: '1 insight generated; mood=productive',
      quickWins: ['Record the next decision'],
      insights: [
        {
          type: 'prediction',
          title: 'Ship the hardening sprint',
          description: 'Momentum is high enough to finish the sprint.',
          confidence: 0.92,
          evidence: [],
          actionable: true,
          actions: ['Ship the sprint'],
        },
      ],
    });

    const assistant = new ProactiveAssistant(
      [],
      {
        minHoursBetweenMessages: 0,
        enableProactive: true,
      },
      store,
    );

    await assistant.check();

    expect(append).toHaveBeenCalledWith(
      'proactive',
      expect.objectContaining({
        type: 'system_event',
        kind: 'proactive_message',
        content: expect.stringContaining('Proactive'),
      }),
    );

    generateSpy.mockRestore();
  });

  it('fails closed when model-d key persistence is requested', async () => {
    const { store, append } = createStore();
    const agents: AgentConfig[] = [
      { id: 'memphis', name: 'Memphis', endpoint: 'local', publicKey: 'pk1', weight: 1 },
    ];
    const model = new ModelD_CollectiveCoordination(
      {
        consensusThreshold: 0.6,
        votingTimeout: 60_000,
        agents,
      },
      store,
    );

    await expect(model.saveKey()).rejects.toThrow(/vault-backed key management/);
    expect(append).not.toHaveBeenCalled();
  });
});
