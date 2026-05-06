/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliContext } from '../context.js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));

/**
 * If the Rust TUI exits cleanly (code 0) faster than this threshold, treat
 * it as suspicious and warn the operator. The TUI's own boot path takes
 * O(100ms) to load config + open terminal; an exit-0 in <SUSPICIOUS_FAST_EXIT_MS
 * almost always means the TUI couldn't do its job and bailed (e.g. stdin
 * not a TTY, missing terminal capabilities, panic during init that the
 * Rust process printed-and-swallowed).
 *
 * Without this check, the operator's symptom is "I ran `memphis tui` and
 * got my shell prompt back instantly with no error" — totally opaque.
 * Captured 2026-04-26 in operator's production log.
 */
const SUSPICIOUS_FAST_EXIT_MS = 500;

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

  const verbose = process.env.MEMPHIS_DEBUG === '1' || context.args.verbose === true;
  if (verbose) {
    process.stderr.write(
      `[memphis tui] launching ${binary ? 'binary' : 'cargo run'}: ${command} ${args.join(' ')}\n`,
    );
    process.stderr.write(
      `[memphis tui] cwd=${PROJECT_ROOT} stdin.isTTY=${process.stdin.isTTY ? 'yes' : 'no'}\n`,
    );
  }

  // Surface the most common silent-exit cause: stdin is not a TTY (e.g.
  // operator piped output, ran in a non-interactive context, or the
  // terminal lost its TTY status). The Rust TUI quits cleanly when it
  // can't open raw mode, leaving the operator with no diagnostic.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      '[memphis tui] WARNING: stdin is not a TTY. The Rust TUI requires an interactive terminal. ' +
        'Run `memphis tui` directly from a shell, not piped/redirected.\n',
    );
  }

  const startedAtMs = Date.now();

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
      const elapsedMs = Date.now() - startedAtMs;
      if (signal) {
        reject(new Error(`Rust TUI exited from signal ${signal} (after ${elapsedMs}ms)`));
        return;
      }
      if (code === 0) {
        // Detect the silent-fast-exit pattern that captured the operator
        // off-guard on 2026-04-26. The exit was clean (code 0) but
        // suspiciously fast — almost certainly the TUI noped out during
        // init without printing a diagnostic.
        if (elapsedMs < SUSPICIOUS_FAST_EXIT_MS) {
          process.stderr.write(
            `[memphis tui] WARNING: Rust TUI exited cleanly after only ${elapsedMs}ms. ` +
              `This is faster than the TUI's own boot path; it likely bailed during init. ` +
              `Common causes: stdin not a TTY (see warning above), missing terminal capabilities, ` +
              `or the Rust binary panicked silently. Re-run with MEMPHIS_DEBUG=1 for more detail.\n`,
          );
        }
        resolvePromise();
        return;
      }
      reject(new Error(`Rust TUI exited with code ${String(code)} (after ${elapsedMs}ms)`));
    });
  });
}
