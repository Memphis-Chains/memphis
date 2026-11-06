import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { readEmbedIndexDimension } from '../../src/infra/storage/embed-index-metadata.js';

it('reads the canonical header independently of the large index body', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'memphis-index-meta-')), 'index.json');
  // Deliberately incomplete body: this operation inspects only the header,
  // and must not claim to validate the rest of the index.
  writeFileSync(path, '{"version":1,"dim":1024,"docs":[' + ' '.repeat(100_000));
  expect(readEmbedIndexDimension(path)).toBe(1024);
});

it('supports older JSON with a different field order', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'memphis-index-meta-')), 'index.json');
  writeFileSync(path, JSON.stringify({ docs: [], dim: 768, version: 1 }));
  expect(readEmbedIndexDimension(path)).toBe(768);
});
