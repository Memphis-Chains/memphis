import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createOperatorChatSessionStore } from '../../src/gateway/operator-chat-session-store.js';
import { createSqliteClient, runMigrations } from '../../src/infra/storage/sqlite/client.js';
import { SqliteOperatorChatSessionRepository } from '../../src/infra/storage/sqlite/repositories/operator-chat-session-repository.js';

describe('operator chat session store', () => {
  it('persists gateway conversation turns into operator_chat_messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-operator-chat-store-'));
    const db = createSqliteClient(`file:${join(dir, 'runtime.db')}`);
    runMigrations(db);

    try {
      const repo = new SqliteOperatorChatSessionRepository(db);
      const store = createOperatorChatSessionStore(repo);

      store.append('primary::operator:local', 'user says hello', 'assistant says hi', {
        channel: 'telegram',
      });

      const messages = store.get('primary::operator:local');
      expect(messages).toEqual([
        { role: 'user', content: 'user says hello' },
        { role: 'assistant', content: 'assistant says hi' },
      ]);

      const persisted = repo.listMessages('primary::operator:local', 10);
      expect(persisted).toHaveLength(2);
      expect(persisted[0]).toMatchObject({
        role: 'user',
        content: 'user says hello',
        provider: 'telegram',
      });
      expect(persisted[1]).toMatchObject({
        role: 'assistant',
        content: 'assistant says hi',
        provider: 'telegram',
      });
    } finally {
      db.close();
    }
  });
});
