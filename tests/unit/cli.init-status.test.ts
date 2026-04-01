import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCliResult } from '../helpers/cli.js';

describe('CLI init status', () => {
  it('prints a first-run plan even when the runtime is not initialized yet', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-cli-init-status-'));
    const envPath = join(runtimeDir, '.env');
    writeFileSync(envPath, 'DEFAULT_PROVIDER=local-fallback\n', 'utf8');

    const result = await runCliResult(['init', 'status', '--json'], {
      env: {
        MEMPHIS_DATA_DIR: join(runtimeDir, '.memphis'),
        MEMPHIS_ENV_FILE: envPath,
        RUST_CHAIN_ENABLED: 'false',
      },
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as {
      state: string;
      plan: {
        nextCommand: string;
        suggestedMode: string | null;
        preview: {
          minimalBaseline: { createdBlocks: number };
          guidedConversation: { createdBlocks: number };
        } | null;
      };
    };
    expect(payload.state).toBe('not-initialized');
    expect(payload.plan.nextCommand).toBe('memphis init');
    expect(payload.plan.suggestedMode).toBe('guided-conversation');
    expect(payload.plan.preview?.minimalBaseline.createdBlocks).toBe(2);
    expect(payload.plan.preview?.guidedConversation.createdBlocks).toBe(4);
  });
});
