import { beforeEach, describe, expect, it } from 'vitest';

import {
  getRecentFrames,
  pushFrame,
  resetFrameBuffer,
  type Frame,
} from '../../src/cognitive/frame-buffer.js';
import { applyCognitiveMode } from '../../src/cognitive/mode-dispatch.js';

function frameFromTurn(turnIdx: number, surface: string, userText: string, assistantText: string): Frame {
  return {
    ts: Date.parse('2026-04-13T12:00:00.000Z') + turnIdx * 1000,
    surface,
    turnId: `turn-${turnIdx}`,
    lastNTurns: [
      { role: 'user', text: userText },
      { role: 'assistant', text: assistantText },
    ],
    activeFilePaths: [],
    activeToolCalls: turnIdx % 2 === 0 ? ['memphis_fs_write'] : [],
  };
}

describe('mode A frame dispatch (frame-buffer → applyCognitiveMode)', () => {
  beforeEach(() => {
    resetFrameBuffer();
  });

  it('exposes the three most-recent frames when turn 4 dispatches in mode A', () => {
    pushFrame(frameFromTurn(1, 'tui', 'open the roadmap', 'opened'));
    pushFrame(frameFromTurn(2, 'tui', 'summarize sprint 5', 'summary...'));
    pushFrame(frameFromTurn(3, 'telegram', 'what next', 'sprint 11'));

    const frames = getRecentFrames();
    expect(frames.map((f) => f.turnId)).toEqual(['turn-1', 'turn-2', 'turn-3']);

    const contribution = applyCognitiveMode('A', { frames }, {});
    expect(contribution.promptFragment).toContain('[mode_A:recent_frames]');
    expect(contribution.promptFragment).toContain('user="open the roadmap"');
    expect(contribution.promptFragment).toContain('user="summarize sprint 5"');
    expect(contribution.promptFragment).toContain('user="what next"');
    expect(contribution.promptFragment).toContain('surface=telegram');
  });

  it('emits no frames block when the buffer is empty', () => {
    const contribution = applyCognitiveMode('A', { frames: getRecentFrames() }, {});
    expect(contribution.promptFragment).not.toContain('[mode_A:recent_frames]');
  });

  it('mode B/C/D/E ignore frames — they are only injected by mode A dispatch', () => {
    pushFrame(frameFromTurn(1, 'tui', 'only mode-A sees me', 'ack'));
    const frames = getRecentFrames();

    for (const mode of ['B', 'C', 'D', 'E'] as const) {
      const c = applyCognitiveMode(mode, { frames }, {});
      expect(c.promptFragment).not.toContain('[mode_A:recent_frames]');
      expect(c.promptFragment).not.toContain('only mode-A sees me');
    }
  });

  it('frames push from different surfaces are all visible in a later mode-A turn', () => {
    pushFrame(frameFromTurn(1, 'tui', 'tui command', 'tui reply'));
    pushFrame(frameFromTurn(2, 'telegram', 'telegram question', 'telegram reply'));
    pushFrame(frameFromTurn(3, 'http', 'http query', 'http reply'));

    const contribution = applyCognitiveMode('A', { frames: getRecentFrames() }, {});
    expect(contribution.promptFragment).toContain('surface=tui');
    expect(contribution.promptFragment).toContain('surface=telegram');
    expect(contribution.promptFragment).toContain('surface=http');
  });
});
