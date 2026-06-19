import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listBlockFiles } from '../../src/infra/storage/chain-file-io.js';

describe('chain file io', () => {
  it('lists only real json block files and skips json-named directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-chain-files-'));
    writeFileSync(join(dir, '000001.json'), '{}', 'utf8');
    mkdirSync(join(dir, '000002.json'));
    writeFileSync(join(dir, 'note.txt'), 'ignore', 'utf8');

    await expect(listBlockFiles(dir)).resolves.toEqual(['000001.json']);
  });
});
