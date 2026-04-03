import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliContext } from '../context.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

function resolveRustTuiBinary(): string | undefined {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = [
    resolve(PROJECT_ROOT, 'target', 'debug', `memphis-tui${suffix}`),
    resolve(PROJECT_ROOT, 'target', 'release', `memphis-tui${suffix}`),
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

export async function runRustTui(context: CliContext): Promise<void> {
  // Force UTF-8 locale for proper Polish/Unicode character rendering
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'en_US.UTF-8',
  };

  const binary = resolveRustTuiBinary();
  const command = binary ?? 'cargo';
  const runtimeArgs = [];
  if (context.args.checkOnly) {
    runtimeArgs.push('--check-only');
    if (context.args.json) {
      runtimeArgs.push('--json');
    }
  }
  if (context.args.runCommand) {
    runtimeArgs.push('--run-command', context.args.runCommand);
    if (context.args.json) {
      runtimeArgs.push('--json');
    }
  }
  const args = binary ? runtimeArgs : ['run', '--quiet', '-p', 'memphis-tui', '--', ...runtimeArgs];

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'inherit',
    });

    child.on('error', (error) => {
      reject(
        new Error(
          `Failed to launch Rust TUI: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Rust TUI exited from signal ${signal}`));
        return;
      }
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`Rust TUI exited with code ${String(code)}`));
    });
  });
}
