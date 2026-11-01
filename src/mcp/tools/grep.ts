/**
 * memphis_grep — code search tool using ripgrep (rg) or fallback grep.
 *
 * Read-only code search. The scope is the tier (2, vault passphrase), not a
 * directory whitelist: `memphis_exec` at the same tier could `grep` any
 * directory anyway. Set `MEMPHIS_CODE_READ_ROOTS` to narrow it back down.
 *
 * Vault material (`.env`, `.env.*`, `vault-state.json`,
 * `vault-entries.json`) is refused: grep output is indexed, and an indexed
 * secret is a plaintext copy outside the encrypted vault.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  assertNotSecretMaterial,
  assertWithinReadRoots,
  displayPrefix,
  escapeForRegExp,
  isVaultMaterialName,
  projectRoot,
  resolveReadPath,
  VAULT_MATERIAL_GLOBS,
} from './read-scope.js';

export type MemphisGrepInput = {
  /** Regex pattern to search for */
  pattern: string;
  /** Optional path (absolute, ~-relative, or relative to ~/memphis/) to search within */
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

/**
 * Refuse a path the read scope does not cover.
 *
 * The rules live in `read-scope.ts`, shared with `memphis_code_read` and
 * `memphis_glob` and mirrored by the native arm.
 */
function assertSearchable(resolvedPath: string): void {
  assertNotSecretMaterial(resolvedPath);
  assertWithinReadRoots(resolvedPath);
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
  return (
    error instanceof Error &&
    /(spawnSync (rg|grep) EPERM|spawnSync (rg|grep) EACCES)/.test(error.message)
  );
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

    // Vault material inside the searched directory: the output is indexed.
    if (isVaultMaterialName(path.basename(current))) return;

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

/**
 * The arguments for the ripgrep invocation.
 *
 * A pure function, so the rule that vault material is excluded from the
 * results can be tested on a host where ripgrep is not installed — which
 * is the case on this host, and the reason the exclusion had no test.
 */
export function buildRipgrepArgs(options: {
  pattern: string;
  searchPath: string;
  limit: number;
  context: number;
  ignoreCase: boolean;
  glob?: string;
}): string[] {
  const args: string[] = [
    '--no-heading',
    '--line-number',
    '--color=never',
    '--max-filesize=2M',
    `--max-count=${options.limit}`,
  ];
  if (options.ignoreCase) args.push('--ignore-case');
  if (options.context > 0) args.push(`--context=${options.context}`);
  for (const excluded of DEFAULT_EXCLUDED_GLOBS) args.push(`--glob=${excluded}`);
  // Vault material inside the searched directory: the directory is not a
  // secret, but a file inside it can be, and the output is indexed.
  for (const excluded of VAULT_MATERIAL_GLOBS) args.push(`--glob=${excluded}`);
  if (options.glob) args.push(`--glob=${options.glob}`);
  args.push('--', options.pattern, options.searchPath);
  return args;
}

/**
 * The arguments for the GNU grep fallback.
 *
 * A pure function, for the same reason as `buildRipgrepArgs`.
 */
export function buildGrepArgs(options: {
  pattern: string;
  searchPath: string;
  limit: number;
  context: number;
  ignoreCase: boolean;
  glob?: string;
}): string[] {
  const args: string[] = ['-rn', '--color=never'];
  for (const excluded of ['node_modules', 'dist', 'target', 'data', 'logs', 'coverage']) {
    args.push(`--exclude-dir=${excluded}`);
  }
  // `--exclude` matches the file name against a glob, so `.env*` is needed
  // to cover `.env.production` too: `--exclude=.env` matches only a file
  // named exactly `.env`.
  for (const excluded of ['.env*', 'vault-state.json', 'vault-entries.json']) {
    args.push(`--exclude=${excluded}`);
  }
  if (options.ignoreCase) args.push('-i');
  if (options.context > 0) args.push(`-C${options.context}`);
  if (options.glob) args.push(`--include=${options.glob}`);
  args.push('-m', String(options.limit), '--', options.pattern, options.searchPath);
  return args;
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

  const root = projectRoot();
  const searchPath = input.path ? resolveReadPath(input.path) : root;
  assertSearchable(searchPath);

  const limit = Math.min(input.limit ?? 50, MAX_RESULTS);
  const context = Math.min(input.context ?? 0, 10);

  const rgBin = findRg();
  const args = rgBin
    ? buildRipgrepArgs({
        pattern: input.pattern,
        searchPath,
        limit,
        context,
        ignoreCase: input.ignoreCase === true,
        glob: input.glob,
      })
    : buildGrepArgs({
        pattern: input.pattern,
        searchPath,
        limit,
        context,
        ignoreCase: input.ignoreCase === true,
        glob: input.glob,
      });

  const bin = rgBin ?? 'grep';

  try {
    const output = execFileSync(bin, args, {
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });

    // Strip the prefix for readability: the install root when the search
    // happened inside it, the search path itself when it happened
    // elsewhere on the host.
    const prefix = escapeForRegExp(displayPrefix(searchPath, root));
    const cleaned = output.replace(new RegExp(prefix + '/', 'g'), '');
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
      return jsSearch(root, searchPath, input.pattern, {
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
