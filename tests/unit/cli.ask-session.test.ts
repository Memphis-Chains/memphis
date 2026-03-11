import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ContextWindowManager } from '../../src/providers/context-window.js';
import { ConversationHistory } from '../../src/providers/conversation-history.js';
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

describe('AskSession helpers', () => {
  it('context window manager respects token limit', () => {
    const manager = new ContextWindowManager(1000);

    const turns = [
      { role: 'user' as const, content: 'A'.repeat(100), timestamp: new Date(), tokenCount: 25 },
      {
        role: 'assistant' as const,
        content: 'B'.repeat(200),
        timestamp: new Date(),
        tokenCount: 50,
      },
      { role: 'user' as const, content: 'C'.repeat(400), timestamp: new Date(), tokenCount: 100 },
      {
        role: 'assistant' as const,
        content: 'D'.repeat(800),
        timestamp: new Date(),
        tokenCount: 200,
      },
    ];

    const context = manager.buildContext(turns);
    const totalTokens = context.reduce((sum, turn) => sum + turn.tokenCount, 0);
    expect(totalTokens).toBeLessThan(1000);
    expect(context.length).toBeGreaterThan(0);
  });

  it('conversation history persists and loads', () => {
    const target = join(tmpdir(), `test-conversation-${Date.now()}.json`);
    const history = new ConversationHistory(target);
    history.clear();

    history.addTurn('user', 'Hello');
    history.addTurn('assistant', 'Hi there!');

    expect(history.getTurns().length).toBe(2);

    const history2 = new ConversationHistory(target);
    expect(history2.getTurns().length).toBe(2);
  });
});
