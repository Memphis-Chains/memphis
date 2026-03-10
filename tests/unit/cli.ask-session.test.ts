import { mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextWindowManager } from '../../src/providers/context-window.js';
import { ConversationHistory } from '../../src/providers/conversation-history.js';

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

describe('AskSession helpers', () => {
  it('context window manager respects token limit', () => {
    const manager = new ContextWindowManager(1000);

    const turns = [
      { role: 'user' as const, content: 'A'.repeat(100), timestamp: new Date(), tokenCount: 25 },
      { role: 'assistant' as const, content: 'B'.repeat(200), timestamp: new Date(), tokenCount: 50 },
      { role: 'user' as const, content: 'C'.repeat(400), timestamp: new Date(), tokenCount: 100 },
      { role: 'assistant' as const, content: 'D'.repeat(800), timestamp: new Date(), tokenCount: 200 },
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
