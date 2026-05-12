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

// REV2 Temat 1 (2026-05-12): additional read-only roots the LLM may
// glob over. Telegram attachments now persist under
// `<data>/state/telegram-attachments/` (default `~/.memphis/state/...`)
// so the agent can re-discover files an operator forwarded earlier.
// Operator's session 2026-05-12 22:31 surfaced the gap — bot told
// operator "Telegram nie zapisuje lokalnie" because (a) the temp
// file had been unlinked and (b) glob refused to look outside
// ~/memphis/. Resolution is run-time so MEMPHIS_DATA_DIR overrides
// (CI, tests, alt installs) work.
function buildAdditionalReadRoots(rawEnv: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  roots.push(path.join(os.homedir(), '.memphis', 'state', 'telegram-attachments'));
  const dataOverride = rawEnv.MEMPHIS_DATA_DIR;
  if (dataOverride && dataOverride.length > 0) {
    roots.push(path.resolve(dataOverride, 'state', 'telegram-attachments'));
  }
  return roots;
}

function isInsideAnyAllowedRoot(resolvedPath: string, extraRoots: string[]): boolean {
  const normalized = path.normalize(resolvedPath);
  if (normalized.startsWith(PROJECT_ROOT + path.sep) || normalized === PROJECT_ROOT) {
    return true;
  }
  for (const root of extraRoots) {
    if (normalized.startsWith(root + path.sep) || normalized === root) return true;
  }
  return false;
}

function assertInProject(
  resolvedPath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (!isInsideAnyAllowedRoot(resolvedPath, buildAdditionalReadRoots(rawEnv))) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Path '${resolvedPath}' is outside ~/memphis/ and the allowed extra roots (telegram-attachments)`,
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

  const searchPath = input.path ? path.resolve(PROJECT_ROOT, input.path) : PROJECT_ROOT;
  assertInProject(searchPath);

  const limit = Math.min(input.limit ?? 100, MAX_RESULTS);
  const fdBin = findFd();

  try {
    let output: string;

    if (fdBin) {
      // fd uses regex by default; --glob makes it use glob patterns
      output = execFileSync(
        fdBin,
        [
          '--glob',
          input.pattern,
          '--type',
          'f',
          '--max-results',
          String(limit),
          '--color',
          'never',
          searchPath,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } else {
      // Fallback to find + shell glob approximation
      output = execFileSync(
        'find',
        [searchPath, '-maxdepth', '10', '-type', 'f', '-name', input.pattern],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
      );
    }

    const allFiles = output.trim().split('\n').filter(Boolean);
    // Strip project root for readability
    const relative = allFiles.map((f) => f.replace(PROJECT_ROOT + '/', ''));
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
