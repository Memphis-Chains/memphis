/**
 * memphis_code_read — safe, read-only file reader restricted to ~/memphis/ codebase.
 *
 * Whitelisted paths only. No writes. No traversal outside ~/memphis/.
 * This tool exists because memphis_exec with cat/grep is Tier 2 (vault passphrase required),
 * but code inspection is a common Tier 1 need. memphis_code_read fills that gap.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isInsideMemphisSandbox, realpathOrNearest } from './fs-permission.js';
import { MEMPHIS_CODE_READ_EXTRA_ROOTS } from '../../config/env-registry.js';
import { AppError } from '../../core/errors.js';

export type MemphisCodeReadInput = {
  /** Absolute or ~-relative path to a file inside ~/memphis/ */
  path: string;
  /** Optional line range: start (1-indexed) */
  startLine?: number;
  /** Optional line range: end (1-indexed, inclusive) */
  endLine?: number;
  /** Limit number of lines returned (max 2000) */
  limit?: number;
};

export type MemphisCodeReadOutput = {
  path: string;
  content: string;
  lineCount: number;
  /** The number of lines in the whole file. */
  totalLines: number;
  truncated: boolean;
  error?: string;
};

/** Resolve ~ and relative paths to absolute, checking the whitelist. */
function resolvePath(inputPath: string): string {
  const projectRoot = path.join(os.homedir(), 'memphis');
  const expanded = inputPath.startsWith('~/')
    ? path.join(os.homedir(), inputPath.slice(2))
    : path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(projectRoot, inputPath);
  return expanded;
}

/**
 * Read-only inspection roots. Keep this narrower than arbitrary $HOME:
 * Memphis source, Memphis operator data, and operator project checkouts are
 * enough for normal agent work while still avoiding accidental secret reads.
 */
function allowedReadRoots(): string[] {
  const home = os.homedir();
  const baseRoots = [
    path.join(home, 'memphis'),
    path.join(home, '.memphis'),
    path.join(home, 'projects'),
  ];
  const extraRoots = MEMPHIS_CODE_READ_EXTRA_ROOTS.read(process.env)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('~/') ? path.join(home, item.slice(2)) : path.resolve(item)));
  return [...baseRoots, ...extraRoots];
}

/**
 * The path segments that are never readable.
 *
 * The native arm names the segment it refused ("matches node_modules
 * and may contain secrets or generated state"); this arm used to say
 * only "is blocked because it may contain secrets", so the same
 * refusal read differently on the two surfaces.
 */
function blockedSegmentLabel(segment: string): string | null {
  if (segment === '.env') return '.env';
  if (segment === 'vault-state.json') return 'vault-state.json';
  if (segment === 'vault-entries.json') return 'vault-entries.json';
  if (segment === '.git') return '.git';
  if (segment === 'node_modules') return 'node_modules';
  if (segment.startsWith('.env.')) return '.env.*';
  return null;
}

function realpathRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return path.normalize(root);
  }
}

function assertInMemphisDir(resolvedPath: string): void {
  const normalized = path.normalize(resolvedPath);
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue;
    const label = blockedSegmentLabel(segment);
    if (label) {
      throw new AppError(
        'VALIDATION_ERROR',
        `Path '${resolvedPath}' is blocked because it matches ${label} and may contain secrets or generated state`,
        403,
      );
    }
  }

  if (isInsideMemphisSandbox(resolvedPath)) return;

  const realTarget = realpathOrNearest(resolvedPath);
  for (const root of allowedReadRoots()) {
    const realRoot = realpathRoot(root);
    if (realTarget === realRoot || realTarget.startsWith(realRoot + path.sep)) return;
  }

  throw new AppError(
    'VALIDATION_ERROR',
    `Path '${resolvedPath}' is outside the allowed read roots: ~/memphis, ~/.memphis, ~/projects`,
    403,
  );
}

const MAX_LINE_COUNT = 2000;
const MAX_CONTENT_CHARS = 500_000; // ~500 KB of text

/**
 * Safely read a file inside ~/memphis/.
 *
 * Supports:
 * - Absolute paths or ~-relative paths
 * - Line range selection (startLine / endLine)
 * - Line count limit (truncation warning)
 */
export function runMemphisCodeRead(input: MemphisCodeReadInput): MemphisCodeReadOutput {
  const resolvedPath = resolvePath(input.path);
  assertInMemphisDir(resolvedPath);

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolvedPath);
  } catch {
    return {
      path: resolvedPath,
      content: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      error: `File not found or not accessible: ${resolvedPath}`,
    };
  }

  if (!stat.isFile()) {
    return {
      path: resolvedPath,
      content: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      error: `Not a regular file: ${resolvedPath}`,
    };
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    return {
      path: resolvedPath,
      content: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // A line terminator is not part of the line, and a trailing newline
  // does not add an empty line. The native arm counts the same way.
  const allLines = rawContent
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  while (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  const totalLines = allLines.length;

  // Apply line range
  let startIdx = 0;
  let endIdx = totalLines;

  if (input.startLine !== undefined) {
    if (input.startLine < 1 || input.startLine > totalLines) {
      return {
        path: resolvedPath,
        content: '',
        lineCount: 0,
        truncated: false,
        error: `startLine ${input.startLine} is out of range (file has ${totalLines} lines)`,
      };
    }
    startIdx = input.startLine - 1;
  }

  if (input.endLine !== undefined) {
    if (input.endLine < startIdx + 1 || input.endLine > totalLines) {
      return {
        path: resolvedPath,
        content: '',
        lineCount: 0,
        truncated: false,
        error: `endLine ${input.endLine} is out of range (file has ${totalLines} lines)`,
      };
    }
    endIdx = input.endLine;
  }

  // Apply limit. A limit outside 1..2000 is refused rather than
  // absorbed: the schema advertises 2000 as the maximum, and the
  // native arm refuses it too. A limit of zero used to return an
  // empty result with no error, which the model could not tell from
  // "this file is empty".
  const requestedLimit = input.limit ?? MAX_LINE_COUNT;
  if (requestedLimit < 1) {
    return {
      path: resolvedPath,
      content: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      error: 'limit must be at least 1',
    };
  }
  if (requestedLimit > MAX_LINE_COUNT) {
    return {
      path: resolvedPath,
      content: '',
      lineCount: 0,
      totalLines: 0,
      truncated: false,
      error: `limit must be at most ${MAX_LINE_COUNT}`,
    };
  }
  const effectiveLimit = requestedLimit;

  // The window the caller asked for, before the limit cuts it.
  const requestedEnd = endIdx;
  if (endIdx - startIdx > effectiveLimit) {
    endIdx = startIdx + effectiveLimit;
  }

  const selectedLines = allLines.slice(startIdx, endIdx);
  const content = selectedLines.join('\n');
  // The window is what the caller named: an explicit endLine, or the
  // whole file when there is none. A file with five thousand lines
  // read at startLine 1, endLine 10 is not truncated -- the ten lines
  // asked for were delivered. Both arms used to say it was, which
  // told the model to re-read a file it had already been given.
  const truncated = endIdx < requestedEnd || content.length > MAX_CONTENT_CHARS;
  const returnedContent = truncated
    ? content.slice(0, MAX_CONTENT_CHARS) + '\n... (truncated)'
    : content;

  return {
    path: resolvedPath,
    content: returnedContent,
    lineCount: endIdx - startIdx,
    totalLines,
    truncated,
  };
}
