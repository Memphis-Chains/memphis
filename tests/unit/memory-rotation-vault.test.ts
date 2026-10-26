import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

vi.mock('../../src/security/vault-boundary.js', () => ({ storeVaultSecret: vi.fn() }));
vi.mock('../../src/infra/storage/chain-adapter.js', () => ({
  appendBlock: vi.fn(async () => ({ index: 1 })),
}));

import { storeVaultSecret } from '../../src/security/vault-boundary.js';
import {
  getMemoryPath,
  loadMemoryEntries,
  rotateMemoryFile,
  writeMemoryActionPersisted,
} from '../../src/soul/memory.js';

it('retains active memory without a plaintext archive when vault archival fails, then retries safely', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-memory-rotation-vault-'));
  const env = {
    ...process.env,
    MEMPHIS_DATA_DIR: root,
    MEMPHIS_HOME: root,
    MEMPHIS_AGENT_NAME: 'Fixture',
  };
  await writeMemoryActionPersisted('reflect', 'synthetic private entry', env);
  const before = readFileSync(getMemoryPath(env), 'utf8');
  vi.mocked(storeVaultSecret).mockImplementation(() => {
    throw new Error('synthetic secret must not be logged');
  });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    rotateMemoryFile(env);
    expect(readFileSync(getMemoryPath(env), 'utf8')).toBe(before);
    expect(readdirSync(join(root, 'config'))).toEqual(['memory.md']);
    expect(warning).toHaveBeenCalledWith(
      'Memory rotation postponed: vault unavailable; active entries retained.',
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic secret');
    vi.mocked(storeVaultSecret).mockReturnValue({} as never);
    rotateMemoryFile(env);
    expect(loadMemoryEntries(env)).toEqual([]);
    expect(vi.mocked(storeVaultSecret).mock.calls.at(-1)?.[1]).toContain('synthetic private entry');
    expect(vi.mocked(storeVaultSecret).mock.calls.at(-1)?.[3]).toBe(env);
    expect(readdirSync(join(root, 'config'))).toEqual(['memory.md']);
  } finally {
    warning.mockRestore();
  }
});
