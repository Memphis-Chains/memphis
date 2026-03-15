import { spawnSync } from 'node:child_process';

import { AppError } from '../../core/errors.js';
import {
  enforceGatewayExecPolicy,
  loadGatewayExecPolicy,
} from '../../gateway/exec-policy.js';

const EXEC_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_CHARS = 4000;

export type MemphisExecInput = {
  command: string;
};

export type MemphisExecOutput = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

/**
 * Execute a safe command via the gateway exec policy.
 * Only allowlisted commands with validated arguments pass through.
 */
export function runMemphisExec(input: MemphisExecInput): MemphisExecOutput {
  const policy = loadGatewayExecPolicy();

  // Enforce allowlist + metachar + argument validation
  enforceGatewayExecPolicy(input.command, policy);

  const result = spawnSync('sh', ['-c', input.command], {
    encoding: 'utf8',
    timeout: EXEC_TIMEOUT_MS,
    stdio: 'pipe',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
    },
  });

  if (result.error) {
    throw new AppError('INTERNAL_ERROR', `exec failed: ${result.error.message}`, 500);
  }

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const truncated = stdout.length > MAX_OUTPUT_CHARS || stderr.length > MAX_OUTPUT_CHARS;

  return {
    command: input.command,
    exitCode: result.status ?? 1,
    stdout: stdout.slice(0, MAX_OUTPUT_CHARS),
    stderr: stderr.slice(0, MAX_OUTPUT_CHARS),
    truncated,
  };
}
