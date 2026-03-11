import { describe, expect, it } from 'vitest';

import {
  getBackupPath,
  getCachePath,
  getChainPath,
  getDataDir,
  getEmbeddingPath,
  getVaultPath,
} from '../../src/config/paths.js';

describe('config paths', () => {
  it('uses default memphis home when MEMPHIS_DATA_DIR is unset', () => {
    const out = getDataDir({} as NodeJS.ProcessEnv);
    expect(out.endsWith('/.memphis')).toBe(true);
  });

  it('uses MEMPHIS_DATA_DIR override for all derived paths', () => {
    const rawEnv = { MEMPHIS_DATA_DIR: '/tmp/memphis-custom' } as NodeJS.ProcessEnv;
    expect(getDataDir(rawEnv)).toBe('/tmp/memphis-custom');
    expect(getChainPath(undefined, rawEnv)).toBe('/tmp/memphis-custom/chains');
    expect(getChainPath('journal', rawEnv)).toBe('/tmp/memphis-custom/chains/journal');
    expect(getEmbeddingPath(rawEnv)).toBe('/tmp/memphis-custom/embeddings');
    expect(getVaultPath(rawEnv)).toBe('/tmp/memphis-custom/vault');
    expect(getCachePath(rawEnv)).toBe('/tmp/memphis-custom/cache');
    expect(getBackupPath(rawEnv)).toBe('/tmp/memphis-custom/backups');
  });
});
