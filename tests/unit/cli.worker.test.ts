import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCliResult } from '../helpers/cli.js';

describe('CLI worker command', () => {
  it('prints worker status in JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-cli-worker-status-'));
    const db = join(dir, 'runtime.db');
    const env = {
      DATABASE_URL: `file:${db}`,
      MEMPHIS_SESSION_TOKEN_SECRET: '0123456789abcdef0123456789abcdef',
      RUST_CHAIN_ENABLED: 'false',
      LOG_LEVEL: 'error',
    };

    const result = await runCliResult(['worker', 'status', '--json'], { env });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toMatchObject({
      ok: true,
      mode: 'worker.status',
      snapshot: {
        tokenReady: true,
      },
    });
  });
});
