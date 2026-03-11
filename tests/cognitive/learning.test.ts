import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningStorage } from '../../src/cognitive/learning.js';
import type { SuggestionFeedback } from '../../src/cognitive/model-a-types.js';

function feedback(tag: string, action: SuggestionFeedback['action'], modifiedTag?: string): SuggestionFeedback {
  return {
    suggested: {
      tag,
      category: 'type',
      confidence: 0.8,
      source: 'pattern',
    },
    action,
    modifiedTag,
    context: {
      content: 'test content',
      timestamp: new Date(),
    },
  };
}

describe('cognitive model B learning storage', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records accept/reject/modify feedback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-learning-'));
    dirs.push(dir);
    const file = join(dir, 'learning-data.json');

    const storage = new LearningStorage(file);
    storage.recordFeedback(feedback('decision', 'accept'));
    storage.recordFeedback(feedback('decision', 'reject'));
    storage.recordFeedback(feedback('decison', 'modify', 'decision'));

    const stats = storage.getStats();
    expect(stats.totalFeedback).toBe(2);
    expect(stats.acceptedTags).toBe(1);
    expect(stats.rejectedTags).toBe(1);
    expect(stats.customTags).toBe(1);
    expect(storage.getAlias('decison')).toBe('decision');
  });

  it('calculates acceptance and rejection rates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-learning-'));
    dirs.push(dir);
    const file = join(dir, 'learning-data.json');

    const storage = new LearningStorage(file);
    storage.recordFeedback(feedback('bug', 'accept'));
    storage.recordFeedback(feedback('bug', 'accept'));
    storage.recordFeedback(feedback('bug', 'reject'));

    const acceptance = storage.getAcceptanceRate('bug');
    const rejection = storage.getRejectionRate('bug');

    expect(acceptance).toBeGreaterThan(0.1);
    expect(acceptance).toBeLessThan(0.9);
    expect(rejection).toBeCloseTo(1 - acceptance, 5);
  });

  it('persists data across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-learning-'));
    dirs.push(dir);
    const file = join(dir, 'learning-data.json');

    const first = new LearningStorage(file);
    first.recordFeedback(feedback('feature', 'accept'));
    first.recordFeedback(feedback('feature', 'reject'));

    const second = new LearningStorage(file);
    const stats = second.getStats();

    expect(stats.totalFeedback).toBe(2);
    expect(second.getAcceptanceRate('feature')).toBeGreaterThan(0.1);
    expect(second.getAcceptanceRate('feature')).toBeLessThan(0.9);
  });

  it('exports and imports aliases and custom tags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-learning-'));
    dirs.push(dir);
    const fileA = join(dir, 'a.json');
    const fileB = join(dir, 'b.json');

    const source = new LearningStorage(fileA);
    source.recordFeedback(feedback('featre', 'modify', 'feature'));

    const dump = source.export();

    const target = new LearningStorage(fileB);
    target.import(dump);

    expect(target.getAlias('featre')).toBe('feature');
    expect(target.isCustomTag('feature')).toBe(true);
  });
});
