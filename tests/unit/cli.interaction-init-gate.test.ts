import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCliResult } from '../helpers/cli.js';

/**
 * S10-5 regression: chat / ask / ask-session / tui must reject with
 * a friendly NOT_INITIALIZED error when memphis init hasn't been run,
 * instead of silently falling back to local-stub responses.
 */
describe('CLI interaction commands gate on first-run', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it('rejects `memphis chat` with NOT_INITIALIZED when first-run state is missing', async () => {
    // Fresh data dir with NO first-run.json, NO chains, NO operator.json.
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-init-gate-'));
    const result = await runCliResult(['chat', '--input', 'hi', '--json'], {
      env: {
        ...originalEnv,
        NODE_ENV: 'test',
        MEMPHIS_DATA_DIR: memphisDir,
        DEFAULT_PROVIDER: 'local-fallback',
        RUST_CHAIN_ENABLED: 'false',
      },
    });

    expect(result.status).not.toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('NOT_INITIALIZED');
    expect(payload.error.message).toContain('memphis init');
  });

  it('error message in non-JSON mode names `memphis init` so the operator knows the next step', async () => {
    const memphisDir = mkdtempSync(join(tmpdir(), 'memphis-init-gate-'));
    const result = await runCliResult(['chat', '--input', 'hi'], {
      env: {
        ...originalEnv,
        NODE_ENV: 'test',
        MEMPHIS_DATA_DIR: memphisDir,
        DEFAULT_PROVIDER: 'local-fallback',
        RUST_CHAIN_ENABLED: 'false',
      },
    });

    expect(result.status).not.toBe(0);
    // The error goes to stderr; either stderr or stdout must name the
    // remediation command exactly.
    const combined = result.stderr + result.stdout;
    expect(combined).toMatch(/memphis init/);
  });
});
