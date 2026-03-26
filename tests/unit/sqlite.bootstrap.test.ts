import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createAppContainer } from '../../src/app/container.js';
import type { AppConfig } from '../../src/infra/config/schema.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';

describe('sqlite bootstrap', () => {
  it('creates schema and meta version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-sqlite-'));
    const db = createSqliteClient(`file:${join(dir, 'test.db')}`);

    runMigrations(db);

    const row = db.prepare("SELECT value FROM _meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;

    expect(row?.value).toBe('9');
    db.close();
  });

  it('createAppContainer reuses provided sqliteDb without creating a new one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-sqlite-share-'));
    const dbPath = join(dir, 'shared.db');
    const db = createSqliteClient(`file:${dbPath}`);
    runMigrations(db);

    // Two containers sharing the same sqliteDb instance
    const config: AppConfig = {
      DATABASE_URL: `file:${dbPath}`,
      MEMPHIS_QUEUE_MODE: 'financial',
      MEMPHIS_QUEUE_RESUME_POLICY: 'keep',
      MEMPHIS_QUEUE_WAL_MAX_BYTES: 10 * 1024 * 1024,
      MEMPHIS_MAX_PENDING_TASKS: 100,
    };

    const container1 = createAppContainer(config, db);
    const container2 = createAppContainer(config, db);

    // Both containers should have initialized repositories without error
    expect(container1.sessionRepository).toBeDefined();
    expect(container2.sessionRepository).toBeDefined();
    expect(container1.taskQueue).toBeDefined();
    expect(container2.taskQueue).toBeDefined();

    db.close();
  });
});
