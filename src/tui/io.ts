import { stdin as processInput, stdout as processOutput } from 'node:process';
import { emitKeypressEvents } from 'node:readline';
import readline from 'node:readline/promises';

export type TuiKeypress = {
  ctrl?: boolean;
  name?: string;
  shift?: boolean;
  meta?: boolean;
};

export type TuiKeypressHandler = (input: string, key: TuiKeypress) => void;
export type TuiResizeHandler = () => void;

export interface TerminalInput {
  readonly isTTY: boolean;
  enableRawMode(): void;
  disableRawMode(): void;
  onKeypress(handler: TuiKeypressHandler): void;
  offKeypress(handler: TuiKeypressHandler): void;
}

export interface TerminalOutput {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  write(value: string): void;
  onResize(handler: TuiResizeHandler): void;
  offResize(handler: TuiResizeHandler): void;
}

export interface TuiLineReader {
  question(prompt: string): Promise<string>;
  close(): void;
}

export interface TerminalIO {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  readonly lineReader: TuiLineReader;
}

export function createProcessTerminalIO(): TerminalIO {
  const input: TerminalInput = {
    get isTTY() {
      return Boolean(processInput.isTTY);
    },
    enableRawMode() {
      if (!processInput.isTTY) return;
      emitKeypressEvents(processInput);
      processInput.setRawMode?.(true);
    },
    disableRawMode() {
      if (!processInput.isTTY) return;
      processInput.setRawMode?.(false);
    },
    onKeypress(handler) {
      processInput.on('keypress', handler);
    },
    offKeypress(handler) {
      processInput.off('keypress', handler);
    },
  };

  const output: TerminalOutput = {
    get columns() {
      return processOutput.columns || 80;
    },
    get rows() {
      return processOutput.rows || 24;
    },
    get isTTY() {
      return Boolean(processOutput.isTTY);
    },
    write(value) {
      processOutput.write(value);
    },
    onResize(handler) {
      processOutput.on('resize', handler);
    },
    offResize(handler) {
      processOutput.off('resize', handler);
    },
  };

  const rl = readline.createInterface({
    input: processInput,
    output: processOutput,
    terminal: true,
  });

  return {
    input,
    output,
    lineReader: {
      question(prompt) {
        return rl.question(prompt);
      },
      close() {
        rl.close();
      },
    },
  };
}
