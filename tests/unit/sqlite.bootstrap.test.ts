import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';

describe('sqlite bootstrap', () => {
  it('creates schema and meta version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v5-sqlite-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);

    runMigrations(db);

    const row = db.prepare("SELECT value FROM _meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;

    expect(row?.value).toBe('1');
    db.close();
  });
});
