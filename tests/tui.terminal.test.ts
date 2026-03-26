import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProcessTerminal } from '../src/tui/terminal.js';

describe('ProcessTerminal resize handling', () => {
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      writable: true,
      value: 100,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      writable: true,
      value: 40,
    });
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    if (columnsDescriptor) {
      Object.defineProperty(process.stdout, 'columns', columnsDescriptor);
    } else {
      delete (process.stdout as { columns?: number }).columns;
    }
    if (rowsDescriptor) {
      Object.defineProperty(process.stdout, 'rows', rowsDescriptor);
    } else {
      delete (process.stdout as { rows?: number }).rows;
    }
  });

  it('forces a full clear-and-rewrite after resize', () => {
    const terminal = new ProcessTerminal();

    terminal.write(['first', 'second']);
    writeSpy.mockClear();

    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      writable: true,
      value: 80,
    });
    Object.defineProperty(process.stdout, 'rows', {
      configurable: true,
      writable: true,
      value: 24,
    });

    terminal.onResize();
    terminal.write(['first', 'second']);

    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0]?.[0])).toContain('\x1b[2J');
  });
});
