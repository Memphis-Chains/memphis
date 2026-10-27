import { mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { kartografCommandHandler } from '../../src/infra/cli/handlers/kartograf.handler.js';

const previousExit = process.exitCode;
afterEach(() => {
  process.exitCode = previousExit;
});
async function verify(file: string) {
  process.exitCode = 0;
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const handled = await kartografCommandHandler.handle({
      args: { command: 'kartograf', subcommand: 'verify', file, json: true },
    } as CliContext);
    expect(handled).toBe(true);
    return JSON.parse(String(log.mock.calls[0][0]));
  } finally {
    log.mockRestore();
  }
}
it('refuses envelope symlinks and oversized files before reading their contents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-envelope-bounds-'));
  const privateFile = join(root, 'synthetic-private.txt');
  writeFileSync(privateFile, 'SYNTHETIC_PRIVATE_SENTINEL');
  const link = join(root, 'checkpoint.json');
  symlinkSync(privateFile, link);
  const linked = await verify(link);
  expect(linked.ok).toBe(false);
  expect(linked.error).toBe('Checkpoint envelope must be a bounded regular file');
  expect(JSON.stringify(linked)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  expect(process.exitCode).toBe(2);
  const large = join(root, 'large.json');
  writeFileSync(large, '');
  truncateSync(large, 1024 * 1024 + 1);
  expect((await verify(large)).error).toBe('Checkpoint envelope must be a bounded regular file');
  expect(process.exitCode).toBe(2);
});
it('does not echo malformed JSON input in its failure response', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-envelope-redaction-'));
  const file = join(root, 'checkpoint.json');
  writeFileSync(file, 'SYNTHETIC_PRIVATE_SENTINEL');
  const result = await verify(file);
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_SENTINEL');
  expect(process.exitCode).toBe(2);
});
