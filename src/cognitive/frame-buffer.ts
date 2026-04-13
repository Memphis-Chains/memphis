/**
 * Frame buffer — bounded in-memory FIFO ring of recent turn "frames" used by
 * cognitive mode A (`ModelA_ConsciousCapture`) to inject short-range context
 * into the next turn's system prompt.
 *
 * A frame is a compact, text-only snapshot of one completed turn:
 *   { ts, surface, turnId, lastNTurns, activeFilePaths, activeToolCalls }
 *
 * Frames are pushed post-turn from `src/gateway/turn-runtime.ts` and read at
 * prepare time by `src/cognitive/mode-dispatch.ts` → `buildModeAFragment`.
 */

export interface FrameTurn {
  role: 'user' | 'assistant' | 'system' | 'tool' | string;
  text: string;
}

export interface Frame {
  ts: number;
  surface: string;
  turnId: string;
  lastNTurns: FrameTurn[];
  activeFilePaths: string[];
  activeToolCalls: string[];
}

export const DEFAULT_FRAME_BUFFER_SIZE = 128;
export const DEFAULT_RECENT_FRAME_COUNT = 5;

function readConfiguredSize(rawEnv: NodeJS.ProcessEnv): number {
  const raw = rawEnv.MEMPHIS_FRAME_BUFFER_SIZE;
  if (!raw) return DEFAULT_FRAME_BUFFER_SIZE;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FRAME_BUFFER_SIZE;
  return Math.min(parsed, 4096);
}

class FrameRingBuffer {
  private buffer: Frame[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  setCapacity(capacity: number): void {
    this.capacity = Math.max(1, capacity);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  push(frame: Frame): void {
    this.buffer.push(frame);
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
  }

  recent(count: number): Frame[] {
    if (count <= 0) return [];
    return this.buffer.slice(-count).map(cloneFrame);
  }

  all(): Frame[] {
    return this.buffer.map(cloneFrame);
  }

  size(): number {
    return this.buffer.length;
  }

  getCapacity(): number {
    return this.capacity;
  }

  clear(): void {
    this.buffer.length = 0;
  }
}

function cloneFrame(frame: Frame): Frame {
  return {
    ts: frame.ts,
    surface: frame.surface,
    turnId: frame.turnId,
    lastNTurns: frame.lastNTurns.map((turn) => ({ role: turn.role, text: turn.text })),
    activeFilePaths: [...frame.activeFilePaths],
    activeToolCalls: [...frame.activeToolCalls],
  };
}

let ringBuffer: FrameRingBuffer = new FrameRingBuffer(
  readConfiguredSize(process.env),
);

export function pushFrame(frame: Frame): void {
  ringBuffer.setCapacity(readConfiguredSize(process.env));
  ringBuffer.push(cloneFrame(frame));
}

export function getRecentFrames(count: number = DEFAULT_RECENT_FRAME_COUNT): Frame[] {
  return ringBuffer.recent(count);
}

export function getAllFrames(): Frame[] {
  return ringBuffer.all();
}

export function getFrameBufferSize(): number {
  return ringBuffer.size();
}

export function getFrameBufferCapacity(): number {
  return ringBuffer.getCapacity();
}

/** Test-only reset. */
export function resetFrameBuffer(): void {
  ringBuffer = new FrameRingBuffer(readConfiguredSize(process.env));
}
