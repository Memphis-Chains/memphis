import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestrationService } from '../src/modules/orchestration/service.js';
import { runTuiApp } from '../src/tui/index.js';
import type { TerminalIO, TuiKeypressHandler, TuiResizeHandler } from '../src/tui/io.js';

type FakeTerminalIO = TerminalIO & {
  writes: string[];
  closeCalled: boolean;
  keypressHandlers: Set<TuiKeypressHandler>;
  resizeHandlers: Set<TuiResizeHandler>;
  enableRawMode: ReturnType<typeof vi.fn>;
  disableRawMode: ReturnType<typeof vi.fn>;
};

function createFakeTerminalIO(lines: string[]): FakeTerminalIO {
  const writes: string[] = [];
  const keypressHandlers = new Set<TuiKeypressHandler>();
  const resizeHandlers = new Set<TuiResizeHandler>();
  let cursor = 0;
  let closeCalled = false;
  const enableRawMode = vi.fn();
  const disableRawMode = vi.fn();

  const io = {
    writes,
    keypressHandlers,
    resizeHandlers,
    enableRawMode,
    disableRawMode,
    input: {
      isTTY: false,
      enableRawMode,
      disableRawMode,
      onKeypress(handler) {
        keypressHandlers.add(handler);
      },
      offKeypress(handler) {
        keypressHandlers.delete(handler);
      },
    },
    output: {
      columns: 100,
      rows: 30,
      isTTY: false,
      write(value: string) {
        writes.push(value);
      },
      onResize(handler) {
        resizeHandlers.add(handler);
      },
      offResize(handler) {
        resizeHandlers.delete(handler);
      },
    },
    lineReader: {
      async question() {
        const next = lines[cursor] ?? '/exit';
        cursor += 1;
        return next;
      },
      close() {
        closeCalled = true;
      },
    },
  } as FakeTerminalIO;

  Object.defineProperty(io, 'closeCalled', {
    get() {
      return closeCalled;
    },
  });

  return io;
}

describe('runTuiApp with injected TerminalIO', () => {
  const originalMemphisDir = process.env.MEMPHIS_DIR;

  afterEach(() => {
    if (originalMemphisDir === undefined) {
      delete process.env.MEMPHIS_DIR;
    } else {
      process.env.MEMPHIS_DIR = originalMemphisDir;
    }
  });

  it('runs against fake I/O without a real TTY and cleans up listeners', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-tui-runtime-'));
    const io = createFakeTerminalIO(['/screen vault', '/exit']);

    process.env.MEMPHIS_DIR = memphisDir;

    try {
      await runTuiApp(
        {
          orchestration: {
            generate: vi.fn(),
          } as OrchestrationService,
        },
        io,
      );

      expect(io.enableRawMode).not.toHaveBeenCalled();
      expect(io.disableRawMode).toHaveBeenCalledOnce();
      expect(io.closeCalled).toBe(true);
      expect(io.keypressHandlers.size).toBe(0);
      expect(io.resizeHandlers.size).toBe(0);
      expect(io.writes.join('')).toContain('VAULT');
    } finally {
      rmSync(memphisDir, { recursive: true, force: true });
    }
  });
});
