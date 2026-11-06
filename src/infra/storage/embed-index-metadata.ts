import { closeSync, openSync, readFileSync, readSync } from 'node:fs';

/** Read the index dimension without parsing every stored vector on health checks.
 * This inspects the canonical v1 header only; it is not an integrity check.
 * Older or noncanonical JSON falls back to the existing full parser.
 */
export function readEmbedIndexDimension(path: string): number | undefined {
  const fd = openSync(path, 'r');
  const prefix = Buffer.alloc(4096);
  let count: number;
  try {
    count = readSync(fd, prefix, 0, prefix.length, 0);
  } finally {
    closeSync(fd);
  }
  const match = /^\s*\{\s*"version"\s*:\s*1\s*,\s*"dim"\s*:\s*(\d+)\s*,\s*"docs"\s*:\s*\[/.exec(
    prefix.toString('utf8', 0, count),
  );
  if (match) {
    const dim = Number(match[1]);
    if (Number.isSafeInteger(dim) && dim > 0) return dim;
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dim?: unknown };
  return typeof parsed.dim === 'number' ? parsed.dim : undefined;
}
