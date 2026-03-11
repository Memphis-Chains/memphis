import { describe, expect, it } from 'vitest';
import type { Block } from '../../src/memory/chain.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';

const now = Date.now();
const ts = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();

const b = (minsAgo: number, type: string, tags: string[], content: string, hash?: string): Block => ({
  timestamp: ts(minsAgo),
  hash,
  chain: 'journal',
  data: { type, tags, content },
});

describe('Model E — comprehensive', () => {
  it('generates daily reflection with core stats', () => {
    const model = new ModelE_MetaCognitiveReflection([
      b(5, 'journal', ['project', 'idea'], 'working on project ideas and planning execution'),
      b(10, 'ask', ['learning'], 'how should we improve tests coverage today'),
      b(20, 'decision', ['success'], 'decide to ship robust coverage and improvements'),
    ]);

    const reflection = model.daily();

    expect(reflection.period).toBe('daily');
    expect(reflection.stats.totalEntries).toBe(3);
    expect(reflection.stats.questionsAsked).toBe(1);
    expect(reflection.stats.decisionsRecorded).toBe(1);
  });

  it('generates weekly and deep reflections', () => {
    const blocks = [
      b(60, 'journal', ['project'], 'project journal content with enough words'),
      b(120, 'journal', ['learning'], 'learning journal content with enough words'),
      b(180, 'journal', ['idea'], 'idea journal content with enough words'),
    ];

    const model = new ModelE_MetaCognitiveReflection(blocks);
    expect(model.weekly().period).toBe('weekly');
    expect(model.deep().period).toBe('deep');
  });

  it('detects contradictions from conflicting decision tags', () => {
    const model = new ModelE_MetaCognitiveReflection([
      b(5, 'decision', ['adopt', 'priority-high'], 'adopt approach', 'h1'),
      b(4, 'decision', ['reject', 'priority-low'], 'reject approach later', 'h2'),
    ]);

    const reflection = model.daily();
    expect(reflection.contradictions.length).toBeGreaterThan(0);
    expect(reflection.contradictions[0].type).toBe('logical');
  });

  it('can disable contradiction detection', () => {
    const model = new ModelE_MetaCognitiveReflection(
      [
        b(5, 'decision', ['adopt'], 'adopt x', 'h1'),
        b(4, 'decision', ['reject'], 'reject x', 'h2'),
      ],
      { contradictionDetection: false },
    );

    const reflection = model.daily();
    expect(reflection.contradictions).toHaveLength(0);
  });

  it('detects blind spots for missing expected categories', () => {
    const model = new ModelE_MetaCognitiveReflection([
      b(5, 'journal', ['misc'], 'misc note with minimal structure and no expected tags'),
      b(4, 'journal', ['misc'], 'another misc note with no expected tags'),
    ]);

    const reflection = model.daily();
    expect(reflection.blindSpots.some((s) => s.includes('No decisions recorded'))).toBe(true);
    expect(reflection.blindSpots.some((s) => s.includes('No questions asked'))).toBe(true);
  });

  it('can disable blind spot analysis', () => {
    const model = new ModelE_MetaCognitiveReflection([b(1, 'journal', ['project'], 'content here')], {
      blindSpotAnalysis: false,
    });

    expect(model.daily().blindSpots).toHaveLength(0);
  });

  it('produces recommendations from actionable insights and blind spots', () => {
    const blocks: Block[] = [
      b(1, 'journal', ['misc'], 'entry one with text'),
      b(2, 'journal', ['misc'], 'entry two with text'),
      b(3, 'journal', ['misc'], 'entry three with text'),
      b(4, 'journal', ['misc'], 'entry four with text'),
      b(5, 'journal', ['misc'], 'entry five with text'),
    ];

    const model = new ModelE_MetaCognitiveReflection(blocks);
    const reflection = model.daily();
    expect(reflection.recommendations.length).toBeGreaterThan(0);
  });

  it('extracts unique-topic anomaly insight', () => {
    const model = new ModelE_MetaCognitiveReflection([
      b(1, 'journal', ['alpha'], 'alpha themed content words words'),
      b(2, 'journal', ['beta'], 'beta themed content words words'),
      b(3, 'journal', ['gamma'], 'gamma themed content words words'),
    ]);

    const reflection = model.daily();
    expect(reflection.insights.some((i) => i.type === 'anomaly')).toBe(true);
  });

  it('formats reflection into readable report', () => {
    const model = new ModelE_MetaCognitiveReflection([
      b(1, 'decision', ['project', 'success'], 'successful project decision details and reasoning'),
      b(2, 'ask', ['learning'], 'what should we do next with this project roadmap'),
    ]);

    const text = model.format(model.daily());
    expect(text).toContain('Memphis Reflection');
    expect(text).toContain('Stats');
  });

  it('returns safe values on empty input', () => {
    const model = new ModelE_MetaCognitiveReflection([]);
    const reflection = model.daily();

    expect(reflection.stats.totalEntries).toBe(0);
    expect(reflection.stats.entriesPerDay).toBe(0);
    expect(reflection.themes).toEqual([]);
  });
});
