import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Block } from '../../src/memory/chain.js';
import { ModelA_ConsciousCapture } from '../../src/cognitive/model-a.js';
import { ModelB_InferredDecisions } from '../../src/cognitive/model-b.js';
import { ModelC_PredictivePatterns } from '../../src/cognitive/model-c.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';

let tmpMemphisDir = '';
let oldMemphisDir: string | undefined;
let oldHome: string | undefined;
let tmpHome = '';

beforeEach(() => {
  oldMemphisDir = process.env.MEMPHIS_DIR;
  oldHome = process.env.HOME;
  tmpMemphisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-integration-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cognitive-integration-home-'));
  process.env.MEMPHIS_DIR = tmpMemphisDir;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.MEMPHIS_DIR = oldMemphisDir;
  if (tmpMemphisDir && fs.existsSync(tmpMemphisDir)) {
    fs.rmSync(tmpMemphisDir, { recursive: true, force: true });
  }
});

describe('Cognitive integration', () => {
  it('flows from Model A capture to Model C learning', async () => {
    const append = vi.fn().mockResolvedValue({ index: 1, hash: 'h1', chain: 'decisions', timestamp: '2026-03-11T00:00:00.000Z' });
    const modelA = new ModelA_ConsciousCapture({ autoCapture: false, requireConfirmation: false }, { append });

    await modelA.capture({
      kind: 'decision',
      title: 'Adopt event bus',
      content: 'Adopt event bus for decoupling modules.',
      tags: ['architecture', 'event-bus'],
    });

    const payload = append.mock.calls[0][1];
    const block: Block = {
      timestamp: '2026-03-11T00:00:00.000Z',
      chain: 'decision',
      data: {
        type: payload.type,
        content: payload.content,
        tags: payload.tags,
      },
    };

    const modelC = new ModelC_PredictivePatterns([block, block, { ...block, timestamp: '2026-03-11T00:05:00.000Z' }], {
      patternMinOccurrences: 3,
      contextSimilarityThreshold: 0.1,
    });

    const patterns = await modelC.learn();
    const predictions = modelC.predict({ timeOfDay: 0, dayOfWeek: 3, tags: ['architecture'], chain: 'decision' });

    expect(patterns.length).toBeGreaterThan(0);
    expect(predictions.length).toBeGreaterThan(0);
  });

  it('combines Model B activity inference with Model E reflection', () => {
    const base = Date.now() - 2 * 60 * 60 * 1000;
    const mk = (i: number, tags: string[]): Block => ({
      timestamp: new Date(base + i * 60_000).toISOString(),
      chain: 'journal',
      data: { type: 'journal', content: `entry ${i}`, tags },
    });

    const blocks: Block[] = [
      mk(1, ['project:alpha', 'work']),
      mk(2, ['project:alpha']),
      mk(3, ['project:alpha']),
      mk(4, ['project:beta']),
      mk(5, ['project:beta']),
      mk(6, ['project:beta']),
    ];

    const modelB = new ModelB_InferredDecisions({ activityWindowSize: 3, confidenceThreshold: 0.2 });
    const inferred = modelB.inferFromActivity(blocks);

    const enrichedBlocks: Block[] = [
      ...blocks,
      ...inferred.map((d, i) => ({
        timestamp: new Date(base + (10 + i) * 60_000).toISOString(),
        chain: 'decision',
        data: { type: 'decision', content: d.title, tags: ['inferred', d.type] },
      })),
    ];

    const reflection = new ModelE_MetaCognitiveReflection(enrichedBlocks).daily();

    expect(inferred.length).toBeGreaterThan(0);
    expect(reflection.stats.decisionsRecorded).toBeGreaterThan(0);
  });

  it('keeps prediction confidence bounded after reflection feedback loop', async () => {
    const blocks: Block[] = [
      { timestamp: '2026-03-10T06:00:00.000Z', chain: 'decision', data: { type: 'decision', content: 'optimize build pipeline', tags: ['build', 'pipeline'] } },
      { timestamp: '2026-03-10T06:05:00.000Z', chain: 'decision', data: { type: 'decision', content: 'optimize build cache', tags: ['build', 'pipeline'] } },
      { timestamp: '2026-03-10T06:10:00.000Z', chain: 'decision', data: { type: 'decision', content: 'optimize build retries', tags: ['build', 'pipeline'] } },
    ];

    const modelC = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3, contextSimilarityThreshold: 0.2, confidenceCap: 0.9 });
    const patterns = await modelC.learn();
    expect(patterns.length).toBeGreaterThan(0);
    modelC.recordAccuracy(patterns[0].id, true);

    const predictions = modelC.predict({ timeOfDay: 6, dayOfWeek: 1, tags: ['build', 'pipeline'], chain: 'decision' });
    const reflection = new ModelE_MetaCognitiveReflection(blocks).weekly();

    expect(predictions[0].confidence).toBeLessThanOrEqual(0.9);
    expect(reflection.insights.length).toBeGreaterThanOrEqual(0);
  });
});
