import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Block } from '../../src/memory/chain.js';
import { ModelC_PredictivePatterns, PatternStorage } from '../../src/cognitive/model-c.js';

let tmpMemphisDir = '';
let oldMemphisDir: string | undefined;
let tmpHome = '';

const makeBlock = (
  timestamp: string,
  tags: string[],
  content: string,
  type: 'decision' | 'journal' | 'ask' = 'decision',
): Block => ({
  timestamp,
  chain: 'decision',
  data: { type, tags, content },
});

beforeEach(() => {
  oldMemphisDir = process.env.MEMPHIS_DIR;
  tmpMemphisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-c-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'model-c-home-'));
  fs.mkdirSync(tmpMemphisDir, { recursive: true });
  process.env.MEMPHIS_DIR = tmpMemphisDir;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.MEMPHIS_DIR = oldMemphisDir;
  if (tmpMemphisDir && fs.existsSync(tmpMemphisDir)) {
    fs.rmSync(tmpMemphisDir, { recursive: true, force: true });
  }
});

describe('Model C — comprehensive', () => {
  it('learns patterns when minimum occurrences are met', async () => {
    const base = new Date('2026-03-10T10:00:00.000Z').getTime();
    const blocks: Block[] = [
      makeBlock(new Date(base).toISOString(), ['api', 'feature'], 'Implement feature for api stability'),
      makeBlock(new Date(base + 60_000).toISOString(), ['api', 'feature'], 'Implement feature for api reliability'),
      makeBlock(new Date(base + 120_000).toISOString(), ['api', 'feature'], 'Implement feature for api performance'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3, contextSimilarityThreshold: 0.3 });
    const patterns = await model.learn();

    expect(patterns.length).toBeGreaterThan(0);
    expect(model.getStats().totalPatterns).toBeGreaterThan(0);
  });

  it('does not create patterns when occurrences are below threshold', async () => {
    const blocks: Block[] = [
      makeBlock('2026-03-10T10:00:00.000Z', ['one'], 'single one'),
      makeBlock('2026-03-11T10:00:00.000Z', ['two'], 'single two'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3 });
    const patterns = await model.learn();

    expect(patterns).toHaveLength(0);
    expect(model.getStats().totalPatterns).toBe(0);
  });

  it('predicts with confidence capped', async () => {
    const base = new Date('2026-03-10T08:00:00.000Z').getTime();
    const blocks: Block[] = [
      makeBlock(new Date(base).toISOString(), ['roadmap', 'release'], 'roadmap release planning'),
      makeBlock(new Date(base + 60_000).toISOString(), ['roadmap', 'release'], 'roadmap release execution'),
      makeBlock(new Date(base + 120_000).toISOString(), ['roadmap', 'release'], 'roadmap release review'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, {
      patternMinOccurrences: 3,
      contextSimilarityThreshold: 0.1,
      confidenceCap: 0.75,
    });

    await model.learn();
    const predictions = model.predict({
      timeOfDay: 8,
      dayOfWeek: 2,
      tags: ['roadmap', 'release'],
      chain: 'decision',
    });

    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions[0].confidence).toBeLessThanOrEqual(0.75);
  });

  it('sorts predictions by confidence descending', async () => {
    const blocks: Block[] = [
      makeBlock('2026-03-10T08:00:00.000Z', ['feature', 'build'], 'build feature build'),
      makeBlock('2026-03-10T08:05:00.000Z', ['feature', 'build'], 'build feature iterate'),
      makeBlock('2026-03-10T08:10:00.000Z', ['feature', 'build'], 'build feature finalize'),
      makeBlock('2026-03-11T20:00:00.000Z', ['ops', 'stability'], 'stability ops hardening'),
      makeBlock('2026-03-11T20:05:00.000Z', ['ops', 'stability'], 'stability ops checks'),
      makeBlock('2026-03-11T20:10:00.000Z', ['ops', 'stability'], 'stability ops monitoring'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3, contextSimilarityThreshold: 0.1 });
    await model.learn();

    const predictions = model.predict({
      timeOfDay: 8,
      dayOfWeek: 1,
      tags: ['feature', 'build'],
      chain: 'decision',
    });

    expect(predictions.length).toBeGreaterThan(0);
    for (let i = 1; i < predictions.length; i++) {
      expect(predictions[i - 1].confidence).toBeGreaterThanOrEqual(predictions[i].confidence);
    }
  });

  it('records and persists accuracy updates', async () => {
    const blocks: Block[] = [
      makeBlock('2026-03-10T08:00:00.000Z', ['tech'], 'tech migrate service'),
      makeBlock('2026-03-10T08:05:00.000Z', ['tech'], 'tech migrate pipeline'),
      makeBlock('2026-03-10T08:10:00.000Z', ['tech'], 'tech migrate tests'),
    ];

    const model = new ModelC_PredictivePatterns(blocks, { patternMinOccurrences: 3, contextSimilarityThreshold: 0.1 });
    const patterns = await model.learn();

    expect(patterns.length).toBeGreaterThan(0);
    const id = patterns[0].id;

    model.recordAccuracy(id, true);
    model.recordAccuracy(id, false);

    const storage = new PatternStorage(tmpMemphisDir);
    const persisted = storage.get(id);

    expect(persisted?.totalPredictions).toBe(2);
    expect(persisted?.correctPredictions).toBe(1);
    expect(persisted?.accuracy).toBe(0.5);
  });

  it('loads malformed storage gracefully', () => {
    fs.writeFileSync(path.join(tmpMemphisDir, 'patterns.json'), '{ bad json');
    const storage = new PatternStorage(tmpMemphisDir);
    expect(storage.count()).toBe(0);
  });

  it('pattern storage supports set/get/delete lifecycle', () => {
    const storage = new PatternStorage(tmpMemphisDir);
    storage.set({
      id: 'p1',
      context: { timeOfDay: 9, dayOfWeek: 2, tags: ['x'], chain: 'decision' },
      prediction: { type: 'technical', title: 'Focus on x', confidence: 0.6, evidence: ['x'] },
      occurrences: 3,
      lastSeen: new Date(),
      created: new Date(),
      updated: new Date(),
    });

    expect(storage.get('p1')?.id).toBe('p1');
    expect(storage.count()).toBe(1);
    expect(storage.delete('p1')).toBe(true);
    expect(storage.count()).toBe(0);
  });

  it('returns zeroed stats when no patterns exist', () => {
    const model = new ModelC_PredictivePatterns([], { patternMinOccurrences: 99 });
    const stats = model.getStats();

    expect(stats.totalPatterns).toBe(0);
    expect(stats.avgOccurrences).toBe(0);
    expect(stats.avgAccuracy).toBe(0);
  });
});
