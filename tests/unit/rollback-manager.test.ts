import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RollbackManager } from '../../src/backup/rollback.js';

describe('RollbackManager', () => {
  it('snapshots and restores the real Memphis data layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mv4-rollback-'));

    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'chains', 'journal'), { recursive: true });
    mkdirSync(join(root, 'vault'), { recursive: true });
    mkdirSync(join(root, 'embeddings'), { recursive: true });
    mkdirSync(join(root, 'sessions'), { recursive: true });

    writeFileSync(join(root, 'config', 'agent-profile.json'), '{"agent":"memphis"}', 'utf8');
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), '{"index":1,"hash":"h1"}', 'utf8');
    writeFileSync(join(root, 'vault', 'entry.json'), '{"ciphertext":"vault-v1"}', 'utf8');
    writeFileSync(join(root, 'embeddings', 'index.json'), '{"dimension":32}', 'utf8');
    writeFileSync(join(root, 'sessions', 'current.json'), '{"messages":1}', 'utf8');
    writeFileSync(join(root, 'case-index.sqlite'), 'case-index-v1', 'utf8');

    const manager = new RollbackManager(root);
    const snapshotId = await manager.createSnapshot('pre-change');

    const snapshots = await manager.listSnapshots();
    expect(snapshots[0]?.id).toBe(snapshotId);

    const snapshotDir = join(root, 'backups', 'snapshots');
    expect(
      readdirSync(snapshotDir).some((entry) => entry.startsWith(`${snapshotId}-`) && entry.endsWith('.tar.gz')),
    ).toBe(true);

    writeFileSync(join(root, 'config', 'agent-profile.json'), '{"agent":"mutated"}', 'utf8');
    writeFileSync(join(root, 'chains', 'journal', '000001.json'), '{"index":1,"hash":"mutated"}', 'utf8');
    writeFileSync(join(root, 'vault', 'entry.json'), '{"ciphertext":"vault-v2"}', 'utf8');
    writeFileSync(join(root, 'embeddings', 'index.json'), '{"dimension":64}', 'utf8');
    writeFileSync(join(root, 'sessions', 'current.json'), '{"messages":99}', 'utf8');
    writeFileSync(join(root, 'case-index.sqlite'), 'case-index-v2', 'utf8');

    const restored = await manager.rollback(snapshotId);
    expect(restored.success).toBe(true);

    expect(readFileSync(join(root, 'config', 'agent-profile.json'), 'utf8')).toContain('memphis');
    expect(readFileSync(join(root, 'chains', 'journal', '000001.json'), 'utf8')).toContain('"h1"');
    expect(readFileSync(join(root, 'vault', 'entry.json'), 'utf8')).toContain('vault-v1');
    expect(readFileSync(join(root, 'embeddings', 'index.json'), 'utf8')).toContain('32');
    expect(readFileSync(join(root, 'sessions', 'current.json'), 'utf8')).toContain('"messages":1');
    expect(readFileSync(join(root, 'case-index.sqlite'), 'utf8')).toBe('case-index-v1');
    expect(existsSync(join(snapshotDir, `${snapshotId}.json`))).toBe(true);
  });
});
