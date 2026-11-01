/**
 * memphis_glob — file discovery tool using glob patterns.
 *
 * Read-only file search. The scope is the tier (2, vault passphrase), not a
 * directory whitelist: `memphis_exec` at the same tier could `find` any
 * directory anyway. Set `MEMPHIS_CODE_READ_ROOTS` to narrow it back down.
 *
 * Vault material (`.env`, `.env.*`, `vault-state.json`,
 * `vault-entries.json`) is refused: the file list is indexed, and an
 * indexed secret is a plaintext copy outside the encrypted vault.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

import {
  assertNotSecretMaterial,
  assertWithinReadRoots,
  displayPrefix,
  escapeForRegExp,
  isVaultMaterialName,
  resolveReadPath,
  VAULT_MATERIAL_GLOBS,
} from './read-scope.js';
import { resolveInstallRoot } from '../../infra/runtime/install-root.js';

export type MemphisGlobInput = {
  /** Glob pattern (e.g. "src/components/*.ts", "*.json") */
  pattern: string;
  /** Optional subdirectory to search within (absolute, ~-relative, or relative to ~/memphis/) */
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

// Codex round-1 W2 (PR #596 review): resolve PROJECT_ROOT via
// `resolveInstallRoot()` instead of hardcoded `~/memphis/`. The
// hardcoded path broke systemd-user / npm-installed-CLI deployments
// where Memphis isn't under HOME/memphis. `resolveInstallRoot()`
// reads MEMPHIS_INSTALL_ROOT env, otherwise falls back to the
// install-root anchor from package.json or repo discovery.
const PROJECT_ROOT = resolveInstallRoot();
const MAX_RESULTS = 500;

/**
 * Refuse a path the read scope does not cover.
 *
 * The rules live in `read-scope.ts`, shared with `memphis_code_read` and
 * `memphis_grep` and mirrored by the native arm.
 */
function assertSearchable(resolvedPath: string): void {
  assertNotSecretMaterial(resolvedPath);
  assertWithinReadRoots(resolvedPath);
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

function normalizeGlobPath(value: string): string {
  return value.replaceAll(path.sep, '/').replace(/^\.\//, '');
}

/**
 * Backend-independent glob matcher used by the `find` fallback. Keep this
 * deliberately small: Memphis documents `*`, `?`, and `**`; character-class
 * and brace expansion are not part of the tool contract.
 */
export function matchesGlobPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = normalizeGlobPath(candidate);
  const normalizedPattern = normalizeGlobPath(pattern);
  let expression = '^';

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];
    const afterNext = normalizedPattern[index + 2];

    if (char === '*' && next === '*') {
      if (afterNext === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    if (char === '*') {
      expression += '[^/]*';
      continue;
    }
    if (char === '?') {
      expression += '[^/]';
      continue;
    }
    expression += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  expression += '$';
  return new RegExp(expression).test(normalizedCandidate);
}

function isImplicitlyIgnored(relativePath: string): boolean {
  return normalizeGlobPath(relativePath)
    .split('/')
    .some(
      (segment) =>
        segment.startsWith('.') ||
        segment === 'node_modules' ||
        segment === 'dist' ||
        segment === 'target' ||
        segment === 'coverage',
    );
}

/**
 * The arguments for the `fd` invocation.
 *
 * A pure function, so the rule that vault material is excluded from the
 * listing can be tested on a host where `fd` is not installed — which is
 * the case on this host, and the reason the exclusion had no test.
 */
export function buildFdArgs(pattern: string, searchPath: string, limit: number): string[] {
  return [
    '--glob',
    pattern,
    '--type',
    'f',
    '--max-results',
    String(limit),
    '--color',
    'never',
    // Vault material inside the listed directory: the file list is indexed.
    ...VAULT_MATERIAL_GLOBS.flatMap((glob) => ['--glob', glob]),
    searchPath,
  ];
}

export function runMemphisGlob(input: MemphisGlobInput): MemphisGlobOutput {
  if (!input.pattern || input.pattern.length > 300) {
    return { files: [], count: 0, truncated: false, error: 'pattern required (max 300 chars)' };
  }

  const searchPath = input.path ? resolveReadPath(input.path, PROJECT_ROOT) : PROJECT_ROOT;
  assertSearchable(searchPath);

  const limit = Math.min(input.limit ?? 100, MAX_RESULTS);
  const fdBin = findFd();

  try {
    let output: string;

    if (fdBin) {
      // fd uses regex by default; --glob makes it use glob patterns
      output = execFileSync(fdBin, buildFdArgs(input.pattern, searchPath, limit), {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    } else {
      // `find -name` only matches basenames, so patterns such as
      // `src/**/*.ts` silently returned zero while fd returned matches.
      // Enumerate files and apply the same path-aware glob contract here.
      const discovered = execFileSync('find', [searchPath, '-maxdepth', '10', '-type', 'f'], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      })
        .trim()
        .split('\n')
        .filter(Boolean)
        .filter((file) => {
          const relativeToSearch = path.relative(searchPath, file);
          return (
            !isImplicitlyIgnored(relativeToSearch) &&
            !isVaultMaterialName(path.basename(file)) &&
            matchesGlobPattern(relativeToSearch, input.pattern)
          );
        })
        .slice(0, limit);
      output = discovered.join('\n');
    }

    const allFiles = output.trim().split('\n').filter(Boolean);
    // Strip the prefix for readability: the install root when the search
    // happened inside it, the search path itself when it happened
    // elsewhere on the host.
    const prefix = escapeForRegExp(displayPrefix(searchPath, PROJECT_ROOT)) + '/';
    const relative = allFiles.map((f) => f.replace(prefix, ''));
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
