/**
 * memphis_package — package manager operations (npm, cargo, apt, pip).
 *
 * Routes through exec policy for safety.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type PackageManager = 'npm' | 'cargo' | 'apt' | 'pip';
export type PackageAction = 'install' | 'remove' | 'list' | 'search';

export type MemphisPackageInput = {
  manager: PackageManager;
  action: PackageAction;
  packages?: string[];
  global?: boolean;
};

export type MemphisPackageOutput = {
  manager: PackageManager;
  action: PackageAction;
  output: string;
  exitCode: number;
  error?: string;
};

const MAX_OUTPUT_BYTES = 32_768;
const TIMEOUT_MS = 120_000;
const PROJECT_ROOT = path.join(os.homedir(), 'memphis');

function buildCommand(input: MemphisPackageInput): { cmd: string; args: string[] } {
  const pkgs = input.packages ?? [];

  switch (input.manager) {
    case 'npm': {
      const actionMap: Record<PackageAction, string> = {
        install: 'install',
        remove: 'uninstall',
        list: 'list',
        search: 'search',
      };
      const args = [actionMap[input.action]];
      if (input.action === 'list') args.push('--depth=0');
      if (input.global && (input.action === 'install' || input.action === 'remove')) {
        args.push('-g');
      }
      args.push(...pkgs);
      return { cmd: 'npm', args };
    }

    case 'cargo': {
      const actionMap: Record<PackageAction, string> = {
        install: 'install',
        remove: 'uninstall',
        list: 'install',
        search: 'search',
      };
      const args = [actionMap[input.action]];
      if (input.action === 'list') args.push('--list');
      args.push(...pkgs);
      return { cmd: 'cargo', args };
    }

    case 'pip': {
      const actionMap: Record<PackageAction, string> = {
        install: 'install',
        remove: 'uninstall',
        list: 'list',
        search: 'search',
      };
      const args = ['-m', 'pip', actionMap[input.action]];
      if (input.action === 'remove') args.push('-y');
      args.push(...pkgs);
      return { cmd: 'python3', args };
    }

    case 'apt': {
      const actionMap: Record<PackageAction, string> = {
        install: 'install',
        remove: 'remove',
        list: 'list',
        search: 'search',
      };
      const args = [actionMap[input.action]];
      if (input.action === 'install' || input.action === 'remove') args.push('-y');
      if (input.action === 'list') args.push('--installed');
      args.push(...pkgs);
      return { cmd: 'apt', args };
    }
  }
}

function validatePackageNames(packages: string[] | undefined): string | undefined {
  if (!packages) return undefined;
  for (const pkg of packages) {
    if (/[;&|`$(){}[\]!#~<>\\\n\r]/.test(pkg)) {
      return `Invalid package name: ${pkg}`;
    }
  }
  return undefined;
}

export function runMemphisPackage(input: MemphisPackageInput): MemphisPackageOutput {
  const validationError = validatePackageNames(input.packages);
  if (validationError) {
    return { manager: input.manager, action: input.action, output: '', exitCode: 1, error: validationError };
  }

  const { cmd, args } = buildCommand(input);

  try {
    const stdout = execFileSync(cmd, args, {
      cwd: PROJECT_ROOT,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 2,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output = stdout.length > MAX_OUTPUT_BYTES
      ? stdout.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)'
      : stdout;

    return { manager: input.manager, action: input.action, output, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const combined = [execErr.stdout ?? '', execErr.stderr ?? ''].join('\n').trim();
    const output = combined.length > MAX_OUTPUT_BYTES
      ? combined.slice(0, MAX_OUTPUT_BYTES) + '\n... (truncated)'
      : combined;

    return {
      manager: input.manager,
      action: input.action,
      output,
      exitCode: execErr.status ?? 1,
      error: execErr.message ?? 'Command failed',
    };
  }
}
