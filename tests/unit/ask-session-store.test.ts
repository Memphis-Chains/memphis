import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendAskSessionTurn,
  askSessionPath,
  askSessionStats,
  buildAskSessionPrompt,
  clearAskSession,
  estimateTokens,
  readAskSession,
  selectContextTurns,
} from '../../src/core/ask-session-store.js';

describe('ask session store', () => {
  it('persists turns in jsonl and can clear session', () => {
    const base = mkdtempSync(join(tmpdir(), 'memphis-ask-session-'));
    const env = { ...process.env, ASK_SESSIONS_DIR: base, ASK_CONTEXT_TURNS: '10', ASK_CONTEXT_WINDOW_TOKENS: '200' };

    appendAskSessionTurn(
      'test',
      { timestamp: new Date().toISOString(), role: 'user', content: 'hello', tokens: estimateTokens('hello') },
      env,
    );
    appendAskSessionTurn(
      'test',
      { timestamp: new Date().toISOString(), role: 'assistant', content: 'hi', tokens: estimateTokens('hi') },
      env,
    );

    const turns = readAskSession('test', env);
    expect(turns).toHaveLength(2);
    expect(askSessionPath('test', env)).toContain(base);

    clearAskSession('test', env);
    expect(readAskSession('test', env)).toHaveLength(0);
  });

  it('builds bounded context and prompt', () => {
    const env = { ...process.env, ASK_CONTEXT_TURNS: '2', ASK_CONTEXT_WINDOW_TOKENS: '100' };
    const turns = [
      { timestamp: 't1', role: 'user' as const, content: 'first', tokens: 10 },
      { timestamp: 't2', role: 'assistant' as const, content: 'second', tokens: 10 },
      { timestamp: 't3', role: 'user' as const, content: 'third', tokens: 10 },
    ];

    const context = selectContextTurns(turns, 2, 100);
    expect(context).toHaveLength(2);
    expect(context[0]?.content).toBe('second');

    const stats = askSessionStats(turns, env);
    expect(stats.contextTurns).toBe(2);

    const prompt = buildAskSessionPrompt(context, 'latest question');
    expect(prompt).toContain('ASSISTANT: second');
    expect(prompt).toContain('USER: latest question');
  });
});
