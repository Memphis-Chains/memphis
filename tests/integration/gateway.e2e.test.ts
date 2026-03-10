import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Gateway } from '../../src/gateway/server.js';

function envForTest(dbFile: string) {
  process.env.NODE_ENV = 'test';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.LOG_LEVEL = 'error';
  process.env.DEFAULT_PROVIDER = 'local-fallback';
  process.env.LOCAL_FALLBACK_ENABLED = 'true';
  process.env.GEN_TIMEOUT_MS = '30000';
  process.env.GEN_MAX_TOKENS = '512';
  process.env.GEN_TEMPERATURE = '0.4';
  process.env.DATABASE_URL = `file:${dbFile}`;
}

describe('Gateway e2e', () => {
  it('maps validation error contract for /provider/chat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v4-gw-'));
    const dbFile = join(dir, 'gw.db');
    envForTest(dbFile);

    const gw = new Gateway({ port: 19089, host: '127.0.0.1', authToken: 'tok' }, dir, dir);
    await gw.start();

    const res = await fetch('http://127.0.0.1:19089/provider/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok', 'x-request-id': 'gw-1' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.requestId).toBe('gw-1');
  });

  it('blocks /exec command outside allowlist in restricted mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-v4-gw-'));
    const dbFile = join(dir, 'gw.db');
    envForTest(dbFile);
    process.env.GATEWAY_EXEC_RESTRICTED_MODE = 'true';
    process.env.GATEWAY_EXEC_ALLOWLIST = 'echo,pwd';

    const gw = new Gateway({ port: 19090, host: '127.0.0.1', authToken: 'tok' }, dir, dir);
    await gw.start();

    const res = await fetch('http://127.0.0.1:19090/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok', 'x-request-id': 'gw-2' },
      body: JSON.stringify({ command: 'cat /etc/hosts' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string; requestId?: string } };
    expect(body.error?.code).toBe('VALIDATION_ERROR');
    expect(body.error?.requestId).toBe('gw-2');
  });
});
