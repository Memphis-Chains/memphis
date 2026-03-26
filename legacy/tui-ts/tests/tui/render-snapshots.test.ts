/**
 * TUI Render Snapshot Tests
 *
 * These tests capture the current render output of TUI screens.
 * They serve as regression guards for the Phase 1 refactor
 * (Terminal + line diffing).
 *
 * After Phase 1, verify these still pass — they should,
 * since Phase 1 only changes HOW output is written, not WHAT is rendered.
 */

import { describe, expect, it, vi } from 'vitest';

import { renderDashboardScreen } from '../../src/tui/screens/DashboardScreen.js';
import { embedSearchScreen } from '../../src/tui/screens/embed-screen.js';
import { FG_COPPER, themedBox } from '../../src/tui/theme.js';

// Mock the embed adapters — importing embedSearchScreen triggers the whole embed-screen.ts module
// which imports storeDurableMemory → durable-memory.ts → embedStore from rust-embed-adapter.js
vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedSearch: vi.fn(() => ({
    count: 2,
    hits: [
      { id: 'memory-1', score: 0.9543, text_preview: 'first result' },
      { id: 'memory-2', score: 0.8721, text_preview: 'second result' },
    ],
  })),
  embedSearchTuned: vi.fn(() => ({
    count: 1,
    hits: [{ id: 'memory-tuned', score: 0.9900, text_preview: 'tuned result' }],
  })),
  // Required by durable-memory.ts → storeDurableMemory (called by embedStoreScreen, not tested)
  embedStore: vi.fn(() => ({ ok: true })),
}));

describe('DashboardScreen render snapshots', () => {
  it('renders to string[] with expected structure at 80 cols', () => {
    const data = {
      stats: {
        totalBlocks: 42,
        todayBlocks: 7,
        modelStatus: 'ok',
        embeddingCount: 128,
        uptime: '2h 34m',
      },
      activities: [
        { time: '14:32', message: 'journal append: 3 blocks' },
        { time: '14:28', message: 'decision recorded: model selection' },
      ],
      insights: {
        topTopics: ['vault', 'embeddings', 'orchestration'],
        patternsLoaded: 12,
        learningAccuracy: 0.87,
        suggestionsPending: 3,
      },
    };

    const lines = renderDashboardScreen(data, 80);

    // Should be an array of lines
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(10);

    // Logo appears for width >= 56 (ASCII art with copper color codes)
    const allText = lines.join('');
    // The logo is ASCII art — check it renders without the word "Memphis" literally
    // (it's decorative box art, not the word)
    expect(lines[0]).toContain('__'); // first line of ASCII art
    expect(lines[5]).toContain('sovereign runtime'); // tagline at logo bottom

    // Contains themed boxes
    expect(allText).toContain('System');
    expect(allText).toContain('Activity');
    expect(allText).toContain('Cognitive');

    // Contains stats
    expect(allText).toContain('42'); // totalBlocks
    expect(allText).toContain('128'); // embeddingCount
  });

  it('renders at narrow width without crashing', () => {
    const data = {
      stats: { totalBlocks: 1, todayBlocks: 1, modelStatus: 'ok', embeddingCount: 0, uptime: '0m' },
      activities: [],
      insights: { topTopics: [], patternsLoaded: 0, learningAccuracy: 0, suggestionsPending: 0 },
    };

    const lines = renderDashboardScreen(data, 60);
    expect(Array.isArray(lines)).toBe(true);
    // Logo skipped at narrow width < 56
    expect(lines.length).toBeGreaterThan(0);
  });

  it('widget collapse/expand changes output', () => {
    const data = {
      stats: { totalBlocks: 1, todayBlocks: 1, modelStatus: 'ok', embeddingCount: 0, uptime: '0m' },
      activities: [],
      insights: { topTopics: [], patternsLoaded: 0, learningAccuracy: 0, suggestionsPending: 0 },
    };

    const collapsed = renderDashboardScreen(data, 80, { expandedWidget: null });
    const expanded = renderDashboardScreen(data, 80, { expandedWidget: 'System' });

    // Expanded widget should produce different (taller) output
    expect(collapsed.length).not.toBe(expanded.length);
  });
});

describe('embedSearchScreen render snapshots', () => {
  it('renders search results as joined string', () => {
    const result = embedSearchScreen('test query', 5, false);

    expect(typeof result).toBe('string');
    expect(result).toContain('embed results:');
    expect(result).toContain('test query');
    expect(result).toContain('memory-1');
    expect(result).toContain('0.9543');
    expect(result).toContain('first result');
  });

  it('renders tuned search differently', () => {
    const result = embedSearchScreen('test query', 5, true);

    expect(typeof result).toBe('string');
    expect(result).toContain('embed results:');
    expect(result).toContain('memory-tuned');
  });
});

describe('themedBox render', () => {
  it('produces correct box structure', () => {
    const lines = themedBox('Test', ['line1', 'line2', 'line3'], 40, FG_COPPER, 6);

    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(8); // top + 6 body + bottom = 8

    // Top border has title and ROUND corner (BOX_ROUND.tl = ╭)
    expect(lines[0]).toContain('Test');
    expect(lines[0]).toContain('\u256d'); // ╭ (ROUND top-left)

    // Bottom border uses ROUND bottom-left
    expect(lines[lines.length - 1]).toContain('\u2570'); // ╰ (ROUND bottom-left)

    // Interior lines have box-drawing chars (vertical)
    expect(lines[1]).toContain('\u2502'); // │
  });

  it('clamps lines to maxLines', () => {
    const lines = themedBox('Test', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 40, FG_COPPER, 3);
    // top + maxLines (3) + bottom = 5
    expect(lines.length).toBe(5);
  });
});

describe('Component interface smoke tests', () => {
  it('DashboardScreen render output is string[] suitable for line diffing', () => {
    const data = {
      stats: { totalBlocks: 1, todayBlocks: 1, modelStatus: 'ok', embeddingCount: 0, uptime: '0m' },
      activities: [],
      insights: { topTopics: [], patternsLoaded: 0, learningAccuracy: 0, suggestionsPending: 0 },
    };

    const lines = renderDashboardScreen(data, 80);

    // Every line must be a string
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }

    // No line should exceed terminal width (with padding)
    for (const line of lines) {
      // Strip ANSI to get visual length
      // eslint-disable-next-line no-control-regex
      const visual = line.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visual.length).toBeLessThanOrEqual(80);
    }
  });
});
