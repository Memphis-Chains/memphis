import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FRAME_BUFFER_SIZE,
  DEFAULT_RECENT_FRAME_COUNT,
  getAllFrames,
  getFrameBufferCapacity,
  getFrameBufferSize,
  getRecentFrames,
  pushFrame,
  resetFrameBuffer,
  type Frame,
} from '../../src/cognitive/frame-buffer.js';

function makeFrame(index: number, surface: string = 'tui'): Frame {
  return {
    ts: 1_000_000_000 + index,
    surface,
    turnId: `turn-${index}`,
    lastNTurns: [
      { role: 'user', text: `user message ${index}` },
      { role: 'assistant', text: `assistant reply ${index}` },
    ],
    activeFilePaths: [`/tmp/file-${index}.ts`],
    activeToolCalls: index % 2 === 0 ? ['memphis_fs_ops'] : [],
  };
}

describe('frame-buffer', () => {
  const originalEnv = process.env.MEMPHIS_FRAME_BUFFER_SIZE;

  beforeEach(() => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = originalEnv ?? '';
    if (!process.env.MEMPHIS_FRAME_BUFFER_SIZE) {
      delete process.env.MEMPHIS_FRAME_BUFFER_SIZE;
    }
    resetFrameBuffer();
  });

  it('starts empty', () => {
    expect(getAllFrames()).toEqual([]);
    expect(getFrameBufferSize()).toBe(0);
    expect(getRecentFrames()).toEqual([]);
  });

  it('default capacity matches DEFAULT_FRAME_BUFFER_SIZE when env unset', () => {
    delete process.env.MEMPHIS_FRAME_BUFFER_SIZE;
    resetFrameBuffer();
    expect(getFrameBufferCapacity()).toBe(DEFAULT_FRAME_BUFFER_SIZE);
  });

  it('honors MEMPHIS_FRAME_BUFFER_SIZE override', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '16';
    resetFrameBuffer();
    expect(getFrameBufferCapacity()).toBe(16);
  });

  it('falls back to default on an invalid env value', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = 'banana';
    resetFrameBuffer();
    expect(getFrameBufferCapacity()).toBe(DEFAULT_FRAME_BUFFER_SIZE);
  });

  it('clamps excessively large configured sizes to 4096', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '9999999';
    resetFrameBuffer();
    expect(getFrameBufferCapacity()).toBe(4096);
  });

  it('pushes frames in order and getRecentFrames returns the last N most-recent', () => {
    for (let i = 0; i < 10; i += 1) {
      pushFrame(makeFrame(i));
    }
    const recent = getRecentFrames(3);
    expect(recent.map((f) => f.turnId)).toEqual(['turn-7', 'turn-8', 'turn-9']);
  });

  it('defaults to DEFAULT_RECENT_FRAME_COUNT when count omitted', () => {
    for (let i = 0; i < DEFAULT_RECENT_FRAME_COUNT + 3; i += 1) {
      pushFrame(makeFrame(i));
    }
    expect(getRecentFrames()).toHaveLength(DEFAULT_RECENT_FRAME_COUNT);
  });

  it('evicts oldest frames in FIFO order when exceeding capacity', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '3';
    resetFrameBuffer();

    pushFrame(makeFrame(0));
    pushFrame(makeFrame(1));
    pushFrame(makeFrame(2));
    pushFrame(makeFrame(3));
    pushFrame(makeFrame(4));

    const all = getAllFrames();
    expect(all.map((f) => f.turnId)).toEqual(['turn-2', 'turn-3', 'turn-4']);
    expect(getFrameBufferSize()).toBe(3);
  });

  it('returns zero frames when count is zero or negative', () => {
    pushFrame(makeFrame(0));
    expect(getRecentFrames(0)).toEqual([]);
    expect(getRecentFrames(-5)).toEqual([]);
  });

  it('roundtrips all frame fields through getRecentFrames', () => {
    const source = makeFrame(42, 'telegram');
    pushFrame(source);
    const [echoed] = getRecentFrames(1);
    expect(echoed).toEqual(source);
  });

  it('returns independent copies from getRecentFrames (mutation-safe)', () => {
    pushFrame(makeFrame(0));
    const [first] = getRecentFrames(1);
    if (!first) throw new Error('expected a frame');
    first.lastNTurns.push({ role: 'user', text: 'injected' });
    first.activeFilePaths.push('/tmp/evil');
    first.activeToolCalls.push('bad');
    const [second] = getRecentFrames(1);
    expect(second?.lastNTurns).toHaveLength(2);
    expect(second?.activeFilePaths).toEqual(['/tmp/file-0.ts']);
    expect(second?.activeToolCalls).toEqual(['memphis_fs_ops']);
  });

  it('cloning frame input prevents post-push mutation from leaking into storage', () => {
    const frame = makeFrame(1);
    pushFrame(frame);
    frame.lastNTurns.push({ role: 'user', text: 'after-push mutation' });
    const [stored] = getRecentFrames(1);
    expect(stored?.lastNTurns).toHaveLength(2);
  });

  it('resetFrameBuffer clears state and re-applies capacity from env', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '2';
    resetFrameBuffer();
    pushFrame(makeFrame(0));
    pushFrame(makeFrame(1));
    resetFrameBuffer();
    expect(getAllFrames()).toEqual([]);
    expect(getFrameBufferCapacity()).toBe(2);
  });

  it('adopts a new capacity on push when env changes mid-session', () => {
    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '5';
    resetFrameBuffer();
    for (let i = 0; i < 5; i += 1) pushFrame(makeFrame(i));
    expect(getFrameBufferSize()).toBe(5);

    process.env.MEMPHIS_FRAME_BUFFER_SIZE = '2';
    pushFrame(makeFrame(5));
    expect(getFrameBufferSize()).toBe(2);
    expect(getAllFrames().map((f) => f.turnId)).toEqual(['turn-4', 'turn-5']);
  });
});
