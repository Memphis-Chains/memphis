import { createHash } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeIdentity(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new Error('identity cannot be empty');
  }

  if (UUID_RE.test(trimmed)) {
    return trimmed;
  }

  return createHash('sha256').update(trimmed, 'utf8').digest('hex');
}
