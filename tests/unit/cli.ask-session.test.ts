import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI ask session mode', () => {
  it('persists session turns and exposes context stats', () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'memphis-cli-ask-session-'));
    const baseEnv = `DEFAULT_PROVIDER=local-fallback ASK_SESSIONS_DIR=${sessionsDir}`;

    const firstRaw = execSync(
      `${baseEnv} npx tsx src/infra/cli/index.ts ask --session test --input "Hello" --json`,
      { encoding: 'utf8' },
    );
    const first = JSON.parse(firstRaw);
    expect(first.session).toBe('test');

    const secondRaw = execSync(
      `${baseEnv} npx tsx src/infra/cli/index.ts ask --session test --input "What did I just say?" --json`,
      { encoding: 'utf8' },
    );
    const second = JSON.parse(secondRaw);
    expect(second.output).toContain('Hello');

    const contextRaw = execSync(
      `${baseEnv} npx tsx src/infra/cli/index.ts ask --session test --input "/context" --json`,
      { encoding: 'utf8' },
    );
    const context = JSON.parse(contextRaw);
    expect(context.mode).toBe('ask-session-context');
    expect(context.turns).toBeGreaterThan(0);
  });
});
