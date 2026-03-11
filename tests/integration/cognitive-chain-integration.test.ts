import { describe, expect, it, vi } from 'vitest';
import type { Block } from '../../src/memory/chain.js';
import type { IStore } from '../../src/cognitive/store.js';
import { ModelA_ConsciousCapture } from '../../src/cognitive/model-a.js';
import { ModelB_InferredDecisions } from '../../src/cognitive/model-b.js';
import { ModelC_PredictivePatterns } from '../../src/cognitive/model-c.js';
import { ModelD_CollectiveCoordination } from '../../src/cognitive/model-d.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import { ProactiveAssistant } from '../../src/cognitive/proactive-assistant.js';

function makeStore() {
  const append = vi.fn(async (chain: string, data: Record<string, unknown>) => ({
    chain,
    data,
    index: 1,
    hash: 'hash-1',
    timestamp: new Date().toISOString(),
  }));

  return { append } as unknown as IStore & { append: ReturnType<typeof vi.fn> };
}

const blocks: Block[] = [
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'Working on api', tags: ['api', 'build'] } },
  { timestamp: new Date().toISOString(), chain: 'decision', data: { type: 'decision', content: 'Choose postgres', tags: ['database', 'adopt'] } },
  { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'Need reflection', tags: ['learning'] } },
];

describe('Cognitive chain integration', () => {
  it('persists outputs from models A-E, InsightGenerator and ProactiveAssistant', async () => {
    const store = makeStore();

    const modelA = new ModelA_ConsciousCapture(undefined, { store });
    await modelA.capture({ kind: 'decision', title: 'Use real chains', content: 'Persist to chain adapter' });

    const modelB = new ModelB_InferredDecisions({ confidenceThreshold: 0 }, store);
    await modelB.persistDecisions([
      {
        id: 'inf-1',
        source: 'activity',
        title: 'Task focus shifted',
        reasoning: 'Tags changed',
        confidence: 0.7,
        category: 'tactical',
        evidence: ['from:a', 'to:b'],
        timestamp: new Date(),
      },
    ]);

    const modelC = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 1, contextSimilarityThreshold: 0 }, store);
    await modelC.learn();

    const modelD = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.5,
      votingTimeout: 60_000,
      agents: [
        { id: 'a1', name: 'A1', endpoint: 'local', publicKey: 'k1', weight: 1 },
        { id: 'a2', name: 'A2', endpoint: 'local', publicKey: 'k2', weight: 1 },
      ],
    }, store);
    const proposal = modelD.propose('Ship feature', 'Should we ship now?', 'a1');
    modelD.vote(proposal.id, 'a1', 'approve');
    modelD.vote(proposal.id, 'a2', 'approve');

    const modelE = new ModelE_MetaCognitiveReflection(blocks, undefined, store);
    modelE.daily();

    const insights = new InsightGenerator(blocks, store);
    await insights.generateDailyInsights();

    const proactive = new ProactiveAssistant(blocks, { minHoursBetweenMessages: 0 }, store);
    await proactive.check();

    await new Promise((resolve) => setTimeout(resolve, 0));

    const chains = store.append.mock.calls.map((c) => c[0]);
    expect(chains).toContain('decisions');
    expect(chains).toContain('patterns');
    expect(chains).toContain('reflections');
    expect(chains).toContain('insights');
    expect(chains).toContain('proactive');
    expect(store.append).toHaveBeenCalled();
  });
});
