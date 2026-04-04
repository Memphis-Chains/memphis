/**
 * memphis_grep — code search tool using ripgrep (rg) or fallback grep.
 *
 * Tier 1: read-only code search restricted to ~/memphis/.
 * No writes, no traversal outside project root.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '../../core/errors.js';

export type MemphisGrepInput = {
  /** Regex pattern to search for */
  pattern: string;
  /** Optional path (relative to ~/memphis/) to search within */
  path?: string;
  /** Glob to filter files (e.g. "*.ts", "*.rs") */
  glob?: string;
  /** Max results to return (default 50, max 200) */
  limit?: number;
  /** Include N lines of context around matches */
  context?: number;
  /** Case-insensitive search */
  ignoreCase?: boolean;
};

export type MemphisGrepOutput = {
  matches: string;
  matchCount: number;
  truncated: boolean;
  error?: string;
};

const PROJECT_ROOT = path.join(os.homedir(), 'memphis');
const MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 200_000;

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

function findRg(): string | null {
  try {
    execFileSync('which', ['rg'], { encoding: 'utf8', timeout: 2000 });
    return 'rg';
  } catch {
    return null;
  }
}

export function runMemphisGrep(input: MemphisGrepInput): MemphisGrepOutput {
  if (!input.pattern || input.pattern.length > 500) {
    return { matches: '', matchCount: 0, truncated: false, error: 'pattern required (max 500 chars)' };
  }

  const searchPath = input.path
    ? path.resolve(PROJECT_ROOT, input.path)
    : PROJECT_ROOT;
  assertInProject(searchPath);

  const limit = Math.min(input.limit ?? 50, MAX_RESULTS);
  const context = Math.min(input.context ?? 0, 10);

  const rgBin = findRg();
  const args: string[] = [];

  if (rgBin) {
    args.push('--no-heading', '--line-number', '--color=never', `--max-count=${limit}`);
    if (input.ignoreCase) args.push('--ignore-case');
    if (context > 0) args.push(`--context=${context}`);
    if (input.glob) args.push(`--glob=${input.glob}`);
    args.push('--', input.pattern, searchPath);
  } else {
    // Fallback to grep
    args.push('-rn', '--color=never');
    if (input.ignoreCase) args.push('-i');
    if (context > 0) args.push(`-C${context}`);
    if (input.glob) args.push(`--include=${input.glob}`);
    args.push('-m', String(limit), '--', input.pattern, searchPath);
  }

  const bin = rgBin ?? 'grep';

  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    // Strip project root prefix for readability
    const cleaned = output.replace(new RegExp(PROJECT_ROOT + '/', 'g'), '');
    const truncated = cleaned.length > MAX_OUTPUT_CHARS;
    const content = truncated ? cleaned.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)' : cleaned;
    const matchCount = content.split('\n').filter(Boolean).length;

    return { matches: content, matchCount, truncated };
  } catch (err: unknown) {
    // rg/grep exit 1 = no matches (not an error)
    const exitCode = (err as { status?: number }).status;
    if (exitCode === 1) {
      return { matches: '', matchCount: 0, truncated: false };
    }
    return {
      matches: '',
      matchCount: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
