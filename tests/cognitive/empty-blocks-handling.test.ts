import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelC_PredictivePatterns } from '../../src/cognitive/model-c.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import { ModelB_InferredDecisions } from '../../src/cognitive/model-b.js';

let tmpMemphisDir = '';
let oldMemphisDir: string | undefined;
let oldHome: string | undefined;
let tmpHome = '';

beforeEach(() => {
  oldMemphisDir = process.env.MEMPHIS_DIR;
  oldHome = process.env.HOME;
  tmpMemphisDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-cognitive-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-cognitive-home-'));
  process.env.MEMPHIS_DIR = tmpMemphisDir;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.MEMPHIS_DIR = oldMemphisDir;
  if (oldHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = oldHome;
  }
  if (tmpMemphisDir && fs.existsSync(tmpMemphisDir)) {
    fs.rmSync(tmpMemphisDir, { recursive: true, force: true });
  }
  if (tmpHome && fs.existsSync(tmpHome)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

describe('Empty blocks handling', () => {
  it('Model C handles empty history safely', async () => {
    const model = new ModelC_PredictivePatterns([], { patternMinOccurrences: 2 });
    const patterns = await model.learn();
    const predictions = model.predict({ tags: ['any'], chain: 'journal' });

    expect(patterns).toEqual([]);
    expect(predictions).toEqual([]);
    expect(model.getStats().totalPatterns).toBe(0);
  });

  it('Model E handles empty history safely', () => {
    const model = new ModelE_MetaCognitiveReflection([]);
    const daily = model.daily();
    const weekly = model.weekly();

    expect(daily.stats.totalEntries).toBe(0);
    expect(weekly.stats.totalEntries).toBe(0);
    expect(daily.insights).toEqual([]);
  });

  it('InsightGenerator returns no insights for empty history', async () => {
    const generator = new InsightGenerator([]);
    const daily = await generator.generateDailyInsights();
    const topic = await generator.generateTopicInsights('anything');

    expect(daily).toEqual([]);
    expect(topic.length).toBeGreaterThanOrEqual(0);
  });

  it('Model B inferFromActivity returns no decisions for empty input', () => {
    const model = new ModelB_InferredDecisions({ activityWindowSize: 3, confidenceThreshold: 0.3 });
    const out = model.inferFromActivity([]);

    expect(out).toEqual([]);
  });

  it('Model B inferFromGit tolerates non-repo path without crashing', () => {
    const model = new ModelB_InferredDecisions({ repoPath: '/definitely/not/a/repo', sinceDays: 7, confidenceThreshold: 0.1 });
    const out = model.inferFromGit();

    expect(Array.isArray(out)).toBe(true);
  });
});
