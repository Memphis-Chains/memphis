import { resolve } from 'node:path';
import { formatCliError, toAppError } from '../../src/core/errors.js';
import { runCli as runCliEntry } from '../../src/infra/cli/index.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const cliPath = resolve(repoRoot, 'src/infra/cli/index.ts');

type CliOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type CapturedConsole = {
  stdout: string[];
  stderr: string[];
  restore: () => void;
};

function applyEnv(env?: NodeJS.ProcessEnv): () => void {
  const previous = { ...process.env };
  const memphisDataDir =
    env?.MEMPHIS_DATA_DIR ??
    env?.MEMPHIS_DIR ??
    (env?.HOME ? resolve(env.HOME, '.memphis') : undefined);

  process.env = {
    ...previous,
    NODE_ENV: 'test',
    MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
    ...(memphisDataDir ? { MEMPHIS_DATA_DIR: memphisDataDir } : {}),
    ...(env ?? {}),
  };

  return () => {
    process.env = previous;
  };
}

function captureWrites(stream: NodeJS.WriteStream): {
  output: string[];
  restore: () => void;
} {
  const output: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string | Uint8Array) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof stream.write;

  return {
    output,
    restore: () => {
      stream.write = original;
    },
  };
}

function captureConsole(): CapturedConsole {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    stdout.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };
  console.info = (...args: unknown[]) => {
    stdout.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };
  console.warn = (...args: unknown[]) => {
    stderr.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };
  console.error = (...args: unknown[]) => {
    stderr.push(`${args.map((arg) => String(arg)).join(' ')}\n`);
  };

  return {
    stdout,
    stderr,
    restore: () => {
      console.log = originalLog;
      console.info = originalInfo;
      console.warn = originalWarn;
      console.error = originalError;
    },
  };
}

export async function runCliResult(
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const restoreEnv = applyEnv(options.env);
  const restoreCwd = options.cwd ? process.cwd() : null;
  const stdout = captureWrites(process.stdout);
  const stderr = captureWrites(process.stderr);
  const consoleCapture = captureConsole();
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;

  try {
    if (options.cwd) {
      process.chdir(options.cwd);
    }
    process.argv = ['node', cliPath, ...args];
    process.exitCode = 0;
    await runCliEntry(['node', cliPath, ...args]);

    return {
      status: process.exitCode ?? 0,
      stdout: `${stdout.output.join('')}${consoleCapture.stdout.join('')}`,
      stderr: `${stderr.output.join('')}${consoleCapture.stderr.join('')}`,
    };
  } catch (error) {
    const verbose = args.includes('--verbose');
    const appError = toAppError(error);
    const message = formatCliError(error, { verbose });
    stderr.output.push(`${message}\n`);
    return {
      status: appError.statusCode >= 500 ? 4 : 2,
      stdout: `${stdout.output.join('')}${consoleCapture.stdout.join('')}`,
      stderr: `${stderr.output.join('')}${consoleCapture.stderr.join('')}`,
    };
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExitCode;
    if (restoreCwd) {
      process.chdir(restoreCwd);
    }
    stdout.restore();
    stderr.restore();
    consoleCapture.restore();
    restoreEnv();
  }
}

export async function runCli(args: string[], options?: CliOptions): Promise<string> {
  const result = await runCliResult(args, options);
  if (result.status === 0) {
    return result.stdout;
  }

  const message = result.stderr || result.stdout || `CLI exited with code ${String(result.status)}`;
  throw new Error(message);
}
