/**
 * memphis_glob — file discovery tool using glob patterns.
 *
 * Tier 1: read-only file search restricted to ~/memphis/.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';

export type MemphisGlobInput = {
  /** Glob pattern (e.g. "src/components/*.ts", "*.json") */
  pattern: string;
  /** Optional subdirectory to search within (relative to ~/memphis/) */
  path?: string;
  /** Max results (default 100, max 500) */
  limit?: number;
};

export type MemphisGlobOutput = {
  files: string[];
  count: number;
  truncated: boolean;
  error?: string;
};

const PROJECT_ROOT = path.join(os.homedir(), 'memphis');
const MAX_RESULTS = 500;

function assertInProject(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  if (!normalized.startsWith(PROJECT_ROOT + path.sep) && normalized !== PROJECT_ROOT) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Path '${resolvedPath}' is outside ~/memphis/`,
      403,
    );
  }
}

function findFd(): string | null {
  for (const bin of ['fd', 'fdfind']) {
    try {
      execFileSync('which', [bin], { encoding: 'utf8', timeout: 2000 });
      return bin;
    } catch {
      // continue
    }
  }
  return null;
}

export function runMemphisGlob(input: MemphisGlobInput): MemphisGlobOutput {
  if (!input.pattern || input.pattern.length > 300) {
    return { files: [], count: 0, truncated: false, error: 'pattern required (max 300 chars)' };
  }

  const searchPath = input.path
    ? path.resolve(PROJECT_ROOT, input.path)
    : PROJECT_ROOT;
  assertInProject(searchPath);

  const limit = Math.min(input.limit ?? 100, MAX_RESULTS);
  const fdBin = findFd();

  try {
    let output: string;

    if (fdBin) {
      // fd uses regex by default; --glob makes it use glob patterns
      output = execFileSync(fdBin, [
        '--glob', input.pattern,
        '--type', 'f',
        '--max-results', String(limit),
        '--color', 'never',
        searchPath,
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      // Fallback to find + shell glob approximation
      output = execFileSync('find', [
        searchPath,
        '-maxdepth', '10',
        '-type', 'f',
        '-name', input.pattern,
      ], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    }

    const allFiles = output.trim().split('\n').filter(Boolean);
    // Strip project root for readability
    const relative = allFiles.map(f => f.replace(PROJECT_ROOT + '/', ''));
    const truncated = relative.length > limit;
    const files = relative.slice(0, limit);

    return { files, count: files.length, truncated };
  } catch (err: unknown) {
    const exitCode = (err as { status?: number }).status;
    if (exitCode === 1) {
      return { files: [], count: 0, truncated: false };
    }
    return {
      files: [],
      count: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
