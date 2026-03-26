import { describe, expect, it } from 'vitest';

import type { TerminalOutput } from '../src/tui/io.js';
import { ProcessTerminal } from '../src/tui/terminal.js';

describe('ProcessTerminal resize handling', () => {
  type FakeOutput = Omit<TerminalOutput, 'columns' | 'rows'> & {
    columns: number;
    rows: number;
    writes: string[];
  };

  function createOutput(): FakeOutput {
    const writes: string[] = [];
    return {
      columns: 100,
      rows: 40,
      isTTY: true,
      writes,
      write(value: string) {
        writes.push(value);
      },
      onResize() {},
      offResize() {},
    };
  }

  it('forces a full clear-and-rewrite after resize', () => {
    const output = createOutput();
    const terminal = new ProcessTerminal(output);

    terminal.write(['first', 'second']);
    output.writes.length = 0;

    output.columns = 80;
    output.rows = 24;

    terminal.onResize();
    terminal.write(['first', 'second']);

    expect(output.writes).toHaveLength(1);
    expect(output.writes[0]).toContain('\x1b[2J');
  });

  it('clears through the injected output sink', () => {
    const output = createOutput();
    const terminal = new ProcessTerminal(output);

    terminal.clearScreen();

    expect(output.writes).toEqual(['\x1b[2J\x1b[H']);
  });
});
