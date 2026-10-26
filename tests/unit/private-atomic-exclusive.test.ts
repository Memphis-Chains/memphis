import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { writePrivateAtomicFile } from '../../src/infra/config/private-atomic-file.js';

it('publishes a complete private file exclusively and never replaces a collision', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-exclusive-'));
  const path = join(root, 'did.json');
  writePrivateAtomicFile(path, 'public identity', { exclusive: true });
  expect(readFileSync(path, 'utf8')).toBe('public identity');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => writePrivateAtomicFile(path, 'replacement', { exclusive: true })).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('public identity');
  expect(readdirSync(root)).toEqual(['did.json']);
});

it('retains the existing replacement behavior for normal atomic writers', () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-replacement-'));
  const path = join(root, 'config');
  writeFileSync(path, 'old');
  writePrivateAtomicFile(path, 'new');
  expect(readFileSync(path, 'utf8')).toBe('new');
  expect(readdirSync(root)).toEqual(['config']);
});
