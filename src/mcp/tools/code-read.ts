/**
 * memphis_code_read — read-only file reader.
 *
 * Reads any file on the host. The scope is the tier (2, vault passphrase),
 * not a whitelist of directories: `memphis_exec` at the same tier could
 * `cat` any file anyway, so a directory whitelist protected nothing — it
 * only made the tool refuse work the operator asked for. Set
 * `MEMPHIS_CODE_READ_ROOTS` to narrow the scope back down.
 *
 * Vault material (`.env`, `.env.*`, `vault-state.json`,
 * `vault-entries.json`) is still refused, because this tool's output is
 * indexed: it lands in the journal and in the semantic embed index, i.e. a
 * plaintext copy of a secret outside the encrypted vault.
 *
 * The policy lives in `read-scope.ts` so the TypeScript and native arms
 * cannot drift apart.
 */

import { readFileSync, statSync } from 'node:fs';

import { assertNotSecretMaterial, assertWithinReadRoots, resolveReadPath } from './read-scope.js';

export type MemphisCodeReadInput = {
  /** Absolute or ~-relative path to a file */
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

/**
 * The refusal message and the allowlist check, in one place.
 *
 * The native arm applies the same two rules in the same order: refuse
 * vault material by segment name, then refuse a path outside the
 * configured roots.
 */
function assertReadable(resolvedPath: string): void {
  assertNotSecretMaterial(resolvedPath);
  assertWithinReadRoots(resolvedPath);
}

const MAX_LINE_COUNT = 2000;
const MAX_CONTENT_CHARS = 500_000; // ~500 KB of text

/**
 * Read a file from the host.
 *
 * Supports:
 * - Absolute paths or ~-relative paths
 * - Line range selection (startLine / endLine)
 * - Line count limit (truncation warning)
 */
export function runMemphisCodeRead(input: MemphisCodeReadInput): MemphisCodeReadOutput {
  const resolvedPath = resolveReadPath(input.path);
  assertReadable(resolvedPath);

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
        totalLines,
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
        totalLines,
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
