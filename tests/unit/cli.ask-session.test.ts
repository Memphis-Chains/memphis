import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAskSessionMessages, selectContextTurns } from '../../src/core/ask-session-store.js';
import { runCli } from '../helpers/cli.js';

describe('CLI ask session mode', () => {
  it('persists session turns and exposes context stats', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'memphis-cli-ask-session-'));
    const env = {
      DEFAULT_PROVIDER: 'local-fallback',
      ASK_SESSIONS_DIR: sessionsDir,
    };

    const first = JSON.parse(
      await runCli(['ask', '--session', 'test', '--input', 'Hello', '--json'], { env }),
    );
    expect(first.session).toBe('test');

    const second = JSON.parse(
      await runCli(['ask', '--session', 'test', '--input', 'What did I just say?', '--json'], {
        env,
      }),
    );
    expect(second.output).toContain('Hello');

    const context = JSON.parse(
      await runCli(['ask', '--session', 'test', '--input', '/context', '--json'], { env }),
    );
    expect(context.mode).toBe('ask-session-context');
    expect(context.turns).toBeGreaterThan(0);
  }, 15000);
});

describe('ask-session helpers', () => {
  it('builds bounded runtime message history from stored turns', () => {
    const turns = [
      { role: 'user' as const, content: 'first', timestamp: 't1', tokens: 25 },
      { role: 'assistant' as const, content: 'second', timestamp: 't2', tokens: 50 },
      { role: 'user' as const, content: 'third', timestamp: 't3', tokens: 100 },
      { role: 'assistant' as const, content: 'fourth', timestamp: 't4', tokens: 200 },
    ];

    const context = selectContextTurns(turns, 2, 180);
    const messages = buildAskSessionMessages(context);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'second' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'third' });
  });
});
