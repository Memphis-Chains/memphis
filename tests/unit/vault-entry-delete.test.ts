import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { deleteVaultEntriesByKey } from '../../src/infra/storage/vault-entry-store.js';

function fixture(entries: Array<{ key: string; id?: string }>): {
  env: NodeJS.ProcessEnv;
  entriesPath: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'mv4-entry-delete-'));
  const entriesPath = join(dir, 'vault-entries.json');
  writeFileSync(
    entriesPath,
    JSON.stringify(
      entries.map((e, i) => ({
        id: e.id ?? `e-${i}`,
        key: e.key,
        encrypted: `enc-${i}`,
        iv: 'iv',
        tag: 'tag',
        createdAt: '2026-04-13T00:00:00Z',
        fingerprint: `fp-${i}`,
      })),
    ),
  );
  return { env: { MEMPHIS_VAULT_ENTRIES_PATH: entriesPath } as NodeJS.ProcessEnv, entriesPath };
}

describe('deleteVaultEntriesByKey', () => {
  it('removes every entry with the matching key and preserves the rest', () => {
    const { env, entriesPath } = fixture([
      { key: 'anthropic_api_key' },
      { key: 'anthropic_api_key' },
      { key: 'minimax_api_key' },
    ]);

    const result = deleteVaultEntriesByKey('anthropic_api_key', env);

    expect(result.removedCount).toBe(2);
    expect(result.remainingCount).toBe(1);

    const after = JSON.parse(readFileSync(entriesPath, 'utf8')) as Array<{ key: string }>;
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe('minimax_api_key');
  });

  it('reports zero removals when the key does not exist', () => {
    const { env } = fixture([{ key: 'minimax_api_key' }]);
    const result = deleteVaultEntriesByKey('missing_key', env);
    expect(result.removedCount).toBe(0);
    expect(result.remainingCount).toBe(1);
  });
});
