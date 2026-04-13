import { describe, expect, it } from 'vitest';

import type { Frame } from '../../src/cognitive/frame-buffer.js';
import {
  applyCognitiveMode,
  listCognitiveModes,
  resolveMaxTokensForStyle,
} from '../../src/cognitive/mode-dispatch.js';
import type { InferredDecision } from '../../src/cognitive/model-b.js';
import type { Prediction } from '../../src/cognitive/types.js';
import type { Block } from '../../src/memory/chain.js';

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    ts: Date.parse('2026-04-13T12:00:00.000Z'),
    surface: 'telegram',
    turnId: 'turn-x',
    lastNTurns: [
      { role: 'user', text: 'hi there' },
      { role: 'assistant', text: 'hello back' },
    ],
    activeFilePaths: [],
    activeToolCalls: [],
    ...overrides,
  };
}

function blockA(title: string, kind = 'note'): Block {
  return {
    chain: 'journal',
    timestamp: new Date().toISOString(),
    data: { type: 'journal', content: title, title, kind, source: 'model-a', tags: [] },
  };
}

function blockReflection(content: string, period: 'daily' | 'weekly' = 'daily'): Block {
  return {
    chain: 'reflections',
    timestamp: new Date().toISOString(),
    data: { type: 'reflection', kind: 'reflection', period, content, source: 'model-e', tags: [] },
  };
}

function inferred(title: string, confidence = 0.75): InferredDecision {
  return {
    id: `inf-${title}`,
    source: 'git',
    title,
    reasoning: 'why',
    confidence,
    category: 'tactical',
    evidence: [],
    timestamp: new Date(),
  };
}

function prediction(title: string, confidence = 0.6): Prediction {
  return {
    type: 'tactical',
    title,
    confidence,
    basedOn: [],
    evidence: [],
  };
}

describe('resolveMaxTokensForStyle', () => {
  it.each([
    ['fast', 1024],
    ['deliberate', 4096],
    ['reflective', 4096],
    ['collaborative', 4096],
    ['meta', 2048],
  ])('maps style %s to %d max tokens', (style, expected) => {
    expect(resolveMaxTokensForStyle(style)).toBe(expected);
  });

  it('falls back to a safe default for unknown styles', () => {
    expect(resolveMaxTokensForStyle('unknown')).toBe(2048);
  });
});

describe('applyCognitiveMode', () => {
  it('lists exactly the five documented modes', () => {
    expect(listCognitiveModes()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('returns mode A contribution with recent Model A captures', () => {
    const blocks = [blockA('first capture'), blockA('second capture'), blockA('third capture')];
    const c = applyCognitiveMode('A', { blocks }, {});
    expect(c.mode).toBe('A');
    expect(c.temperature).toBe(0.3);
    expect(c.maxTokens).toBe(1024);
    expect(c.promptFragment).toContain('[mode_A:recent_captures]');
    expect(c.promptFragment).toContain('third capture');
  });

  it('returns mode B contribution with inferred decisions', () => {
    const c = applyCognitiveMode(
      'B',
      { inferred: [inferred('rename util', 0.9), inferred('refactor', 0.6)] },
      {},
    );
    expect(c.mode).toBe('B');
    expect(c.temperature).toBe(0.5);
    expect(c.maxTokens).toBe(4096);
    expect(c.promptFragment).toContain('[mode_B:inferred_decisions]');
    expect(c.promptFragment).toContain('rename util');
    expect(c.promptFragment).toContain('90%');
  });

  it('returns mode C contribution with predictions', () => {
    const c = applyCognitiveMode(
      'C',
      { predictions: [prediction('try provider cascade', 0.55)] },
      {},
    );
    expect(c.mode).toBe('C');
    expect(c.temperature).toBe(0.7);
    expect(c.maxTokens).toBe(4096);
    expect(c.promptFragment).toContain('[mode_C:predicted_next_actions]');
    expect(c.promptFragment).toContain('try provider cascade');
  });

  it('mode D pass-through when MEMPHIS_COGNITIVE_PEERS is unset', () => {
    const c = applyCognitiveMode('D', {}, {});
    expect(c.mode).toBe('D');
    expect(c.temperature).toBe(0.4);
    expect(c.maxTokens).toBe(4096);
    expect(c.promptFragment).toMatch(/single-agent pass-through/);
  });

  it('mode D lists peers when MEMPHIS_COGNITIVE_PEERS is set', () => {
    const c = applyCognitiveMode('D', {}, { MEMPHIS_COGNITIVE_PEERS: 'peer-a, peer-b' });
    expect(c.promptFragment).toContain('coordinating with 2 peer(s)');
    expect(c.promptFragment).toContain('peer-a');
  });

  it('mode E attaches the latest reflection when present', () => {
    const blocks = [blockReflection('old daily reflection'), blockReflection('newest daily reflection')];
    const c = applyCognitiveMode('E', { blocks }, {});
    expect(c.mode).toBe('E');
    expect(c.temperature).toBe(0.2);
    expect(c.maxTokens).toBe(2048);
    expect(c.promptFragment).toContain('[mode_E:reflection:daily]');
    expect(c.promptFragment).toContain('newest daily reflection');
  });

  it('mode E signals no prior reflection when none exist', () => {
    const c = applyCognitiveMode('E', { blocks: [] }, {});
    expect(c.promptFragment).toContain('no prior reflection available');
  });

  it('passes through config for the requested mode', () => {
    for (const mode of listCognitiveModes()) {
      const c = applyCognitiveMode(mode, {}, {});
      expect(c.config.name).toBeTruthy();
      expect(c.config.style).toBeTruthy();
      expect(c.temperature).toBe(c.config.temperature);
    }
  });

  it('truncates long titles so the fragment stays compact', () => {
    const longTitle = 'x'.repeat(1000);
    const c = applyCognitiveMode('B', { inferred: [inferred(longTitle, 0.9)] }, {});
    expect(c.promptFragment.length).toBeLessThan(400);
  });

  it('mode A renders a recent-frames block when frames are supplied', () => {
    const frames = [
      makeFrame({
        turnId: 'turn-1',
        surface: 'tui',
        lastNTurns: [
          { role: 'user', text: 'deploy the staging service' },
          { role: 'assistant', text: 'deploying…' },
        ],
        activeToolCalls: ['memphis_exec'],
        activeFilePaths: ['/srv/app/deploy.sh'],
      }),
      makeFrame({
        turnId: 'turn-2',
        surface: 'telegram',
        lastNTurns: [
          { role: 'user', text: 'status?' },
          { role: 'assistant', text: 'healthy' },
        ],
      }),
    ];
    const c = applyCognitiveMode('A', { frames }, {});
    expect(c.promptFragment).toContain('[mode_A:recent_frames]');
    expect(c.promptFragment).toContain('surface=tui');
    expect(c.promptFragment).toContain('surface=telegram');
    expect(c.promptFragment).toContain('tools=memphis_exec');
    expect(c.promptFragment).toContain('files=/srv/app/deploy.sh');
    expect(c.promptFragment).toContain('user="deploy the staging service"');
    expect(c.promptFragment).toContain('user="status?"');
  });

  it('mode A merges captures and frames into a combined fragment', () => {
    const blocks = [blockA('deliberate capture')];
    const frames = [makeFrame({ turnId: 'turn-99' })];
    const c = applyCognitiveMode('A', { blocks, frames }, {});
    expect(c.promptFragment).toContain('[mode_A:recent_captures]');
    expect(c.promptFragment).toContain('deliberate capture');
    expect(c.promptFragment).toContain('[mode_A:recent_frames]');
  });

  it('mode A omits the frames block when the frames list is empty', () => {
    const c = applyCognitiveMode('A', { frames: [] }, {});
    expect(c.promptFragment).not.toContain('[mode_A:recent_frames]');
  });

  it('mode A keeps only the trailing 5 frames in the fragment', () => {
    const frames = Array.from({ length: 8 }).map((_, idx) =>
      makeFrame({ turnId: `turn-${idx}`, surface: `s${idx}` }),
    );
    const c = applyCognitiveMode('A', { frames }, {});
    expect(c.promptFragment).not.toContain('surface=s0');
    expect(c.promptFragment).not.toContain('surface=s2');
    expect(c.promptFragment).toContain('surface=s3');
    expect(c.promptFragment).toContain('surface=s7');
  });

  it('mode A truncates very long user text inside frame lines', () => {
    const frames = [
      makeFrame({
        turnId: 'turn-long',
        lastNTurns: [{ role: 'user', text: 'x'.repeat(500) }],
      }),
    ];
    const c = applyCognitiveMode('A', { frames }, {});
    const frameLine = c.promptFragment
      .split('\n')
      .find((line) => line.startsWith('- t='));
    expect(frameLine).toBeDefined();
    expect(frameLine!.length).toBeLessThan(300);
  });
});
