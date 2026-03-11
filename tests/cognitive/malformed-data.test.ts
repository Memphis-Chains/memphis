import { describe, expect, it } from 'vitest';
import type { Block } from '../../src/memory/chain.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';
import { ModelC_PredictivePatterns } from '../../src/cognitive/model-c.js';
import { ModelD_CollectiveCoordination } from '../../src/cognitive/model-d.js';

describe('Malformed data handling', () => {
  it('Model E throws on malformed block without data payload', () => {
    const malformed = [{ timestamp: new Date().toISOString(), chain: 'journal' } as Block];
    const model = new ModelE_MetaCognitiveReflection(malformed);

    expect(() => model.daily()).toThrow();
  });

  it('Model C throws when malformed block lacks data.type', async () => {
    const malformed = [
      { timestamp: '2026-03-11T00:00:00.000Z', chain: 'decision', data: {} },
      { timestamp: '2026-03-11T00:01:00.000Z', chain: 'decision', data: {} },
      { timestamp: '2026-03-11T00:02:00.000Z', chain: 'decision', data: {} },
    ] as unknown as Block[];

    const model = new ModelC_PredictivePatterns(malformed, { patternMinOccurrences: 2 });
    await expect(model.learn()).rejects.toThrow();
  });

  it('Model D rejects operations for unknown proposal ids', () => {
    const model = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.6,
      votingTimeout: 10_000,
      agents: [{ id: 'memphis', name: 'Memphis', endpoint: 'local', publicKey: 'k', weight: 1 }],
    });

    expect(() => model.vote('missing', 'memphis', 'approve')).toThrow(/not found/);
    expect(() => model.closeVoting('missing')).toThrow(/not found/);
    expect(() => model.execute('missing', 'memphis')).toThrow(/not found/);
  });

  it('Model D rejects late vote when proposal deadline passed', () => {
    const model = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.6,
      votingTimeout: -1,
      agents: [{ id: 'memphis', name: 'Memphis', endpoint: 'local', publicKey: 'k', weight: 1 }],
    });

    const proposal = model.propose('Late vote test', 'deadline should pass immediately', 'memphis');
    expect(() => model.vote(proposal.id, 'memphis', 'approve')).toThrow(/deadline/);
  });

  it('Model D rejects execution of non-approved proposals', () => {
    const model = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.8,
      votingTimeout: 10_000,
      agents: [
        { id: 'a', name: 'A', endpoint: 'local', publicKey: 'k1', weight: 1 },
        { id: 'b', name: 'B', endpoint: 'local', publicKey: 'k2', weight: 1 },
      ],
    });

    const proposal = model.propose('Strict consensus', 'requires high threshold', 'a');
    model.vote(proposal.id, 'a', 'reject');

    expect(() => model.execute(proposal.id, 'a')).toThrow(/must be approved/);
  });
});
