/**
 * memphis_grep — code search tool using ripgrep (rg) or fallback grep.
 *
 * Tier 1: read-only code search restricted to ~/memphis/.
 * No writes, no traversal outside project root.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

const MAX_RESULTS = 200;
const MAX_OUTPUT_CHARS = 200_000;
const DEFAULT_EXCLUDED_GLOBS = [
  '!node_modules/**',
  '!dist/**',
  '!target/**',
  '!data/**',
  '!logs/**',
  '!coverage/**',
  '!apps/node_modules/**',
  '!apps/dist/**',
  '!apps/src-tauri/target/**',
] as const;
const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  'data',
  'logs',
  'coverage',
]);

function assertInProject(resolvedPath: string): void {
  const projectRoot = getProjectRoot();
  const normalized = path.normalize(resolvedPath);
  if (!normalized.startsWith(projectRoot + path.sep) && normalized !== projectRoot) {
    throw new AppError('VALIDATION_ERROR', `Path '${resolvedPath}' is outside ~/memphis/`, 403);
  }
}

function getProjectRoot(): string {
  return path.join(os.homedir(), 'memphis');
}

function findRg(): string | null {
  try {
    execFileSync('which', ['rg'], { encoding: 'utf8', timeout: 2000 });
    return 'rg';
  } catch {
    return null;
  }
}

function isExecUnavailable(error: unknown): boolean {
  return error instanceof Error && /(spawnSync (rg|grep) EPERM|spawnSync (rg|grep) EACCES)/.test(error.message);
}

function jsSearch(
  projectRoot: string,
  searchPath: string,
  pattern: string,
  options: {
    limit: number;
    ignoreCase: boolean;
  },
): MemphisGrepOutput {
  const flags = options.ignoreCase ? 'iu' : 'u';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    return {
      matches: '',
      matchCount: 0,
      truncated: false,
      error: `invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const lines: string[] = [];
  const visit = (current: string): void => {
    if (lines.length >= options.limit) return;

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(current);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      if (DEFAULT_EXCLUDED_DIRS.has(path.basename(current))) return;
      for (const entry of readdirSync(current)) {
        visit(path.join(current, entry));
        if (lines.length >= options.limit) return;
      }
      return;
    }

    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return;

    let content: string;
    try {
      content = readFileSync(current, 'utf8');
    } catch {
      return;
    }

    const rel = path.relative(projectRoot, current);
    const fileLines = content.split('\n');
    for (let i = 0; i < fileLines.length && lines.length < options.limit; i += 1) {
      regex.lastIndex = 0;
      if (regex.test(fileLines[i] ?? '')) {
        lines.push(`${rel}:${i + 1}:${fileLines[i]}`);
      }
    }
  };

  visit(searchPath);
  const matches = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  return {
    matches,
    matchCount: lines.length,
    truncated: lines.length >= options.limit,
  };
}

export function runMemphisGrep(input: MemphisGrepInput): MemphisGrepOutput {
  if (!input.pattern || input.pattern.length > 500) {
    return {
      matches: '',
      matchCount: 0,
      truncated: false,
      error: 'pattern required (max 500 chars)',
    };
  }

  const projectRoot = getProjectRoot();
  const searchPath = input.path ? path.resolve(projectRoot, input.path) : projectRoot;
  assertInProject(searchPath);

  const limit = Math.min(input.limit ?? 50, MAX_RESULTS);
  const context = Math.min(input.context ?? 0, 10);

  const rgBin = findRg();
  const args: string[] = [];

  if (rgBin) {
    args.push(
      '--no-heading',
      '--line-number',
      '--color=never',
      '--max-filesize=2M',
      `--max-count=${limit}`,
    );
    if (input.ignoreCase) args.push('--ignore-case');
    if (context > 0) args.push(`--context=${context}`);
    for (const excluded of DEFAULT_EXCLUDED_GLOBS) args.push(`--glob=${excluded}`);
    if (input.glob) args.push(`--glob=${input.glob}`);
    args.push('--', input.pattern, searchPath);
  } else {
    // Fallback to grep
    args.push('-rn', '--color=never');
    for (const excluded of [
      'node_modules',
      'dist',
      'target',
      'data',
      'logs',
      'coverage',
    ]) {
      args.push(`--exclude-dir=${excluded}`);
    }
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
    const cleaned = output.replace(new RegExp(projectRoot + '/', 'g'), '');
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
    if (isExecUnavailable(err)) {
      return jsSearch(projectRoot, searchPath, input.pattern, {
        limit,
        ignoreCase: input.ignoreCase === true,
      });
    }
    return {
      matches: '',
      matchCount: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
