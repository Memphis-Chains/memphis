import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendAskSessionTurn,
  askSessionPath,
  askSessionStats,
  buildAskSessionMessages,
  clearAskSession,
  estimateTokens,
  readAskSession,
  selectContextTurns,
} from '../../src/core/ask-session-store.js';

describe('ask session store', () => {
  it('rejects paths as session names without reading, appending or clearing outside the session directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-session-boundary-'));
    const base = join(root, 'sessions');
    mkdirSync(base);
    const outside = join(root, 'outside.jsonl');
    const sentinel = '{"role":"user","content":"synthetic","timestamp":"t","tokens":1}\n';
    writeFileSync(outside, sentinel);
    const env = { ASK_SESSIONS_DIR: base };
    const turn = { role: 'user' as const, content: 'synthetic', timestamp: 't', tokens: 1 };
    for (const name of [
      '../outside',
      outside.slice(0, -6),
      '..\\outside',
      'C:\\outside',
      '/tmp/outside',
      '',
      '  ',
      'bad\u0000name',
      'bad\nname',
    ]) {
      expect(() => askSessionPath(name, env)).toThrow(/Invalid session name/);
      expect(() => readAskSession(name, env)).toThrow(/Invalid session name/);
      expect(() => appendAskSessionTurn(name, turn, env)).toThrow(/Invalid session name/);
      expect(() => clearAskSession(name, env)).toThrow(/Invalid session name/);
    }
    expect(readFileSync(outside, 'utf8')).toBe(sentinel);
    expect(askSessionPath('sesja-zażółć.1', env)).toBe(join(base, 'sesja-zażółć.1.jsonl'));
  });

  it('does not follow an existing session-file symlink for reads, appends or clears', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-session-symlink-'));
    const base = join(root, 'sessions');
    mkdirSync(base);
    const outside = join(root, 'outside.jsonl');
    const sentinel = '{"role":"user","content":"synthetic","timestamp":"t","tokens":1}\n';
    writeFileSync(outside, sentinel);
    symlinkSync(outside, join(base, 'link.jsonl'));
    const env = { ASK_SESSIONS_DIR: base };
    const turn = { role: 'user' as const, content: 'synthetic', timestamp: 't', tokens: 1 };
    expect(() => readAskSession('link', env)).toThrow();
    expect(() => appendAskSessionTurn('link', turn, env)).toThrow();
    expect(() => clearAskSession('link', env)).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe(sentinel);
  });

  it('does not read, append to, or truncate a hard-linked session file', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-session-hardlink-'));
    const base = join(root, 'sessions');
    mkdirSync(base);
    const outside = join(root, 'outside.jsonl');
    const sentinel = '{"role":"user","content":"synthetic","timestamp":"t","tokens":1}\n';
    writeFileSync(outside, sentinel);
    linkSync(outside, join(base, 'link.jsonl'));
    const env = { ASK_SESSIONS_DIR: base };
    const turn = { role: 'user' as const, content: 'synthetic', timestamp: 't', tokens: 1 };
    expect(() => readAskSession('link', env)).toThrow(/hard links/);
    expect(() => appendAskSessionTurn('link', turn, env)).toThrow(/hard links/);
    expect(() => clearAskSession('link', env)).toThrow(/hard links/);
    expect(readFileSync(outside, 'utf8')).toBe(sentinel);
  });

  it('rejects a named pipe without waiting for a reader or writer', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-session-fifo-'));
    const base = join(root, 'sessions');
    mkdirSync(base);
    execFileSync('mkfifo', [join(base, 'pipe.jsonl')]);
    const env = { ASK_SESSIONS_DIR: base };
    const turn = { role: 'user' as const, content: 'synthetic', timestamp: 't', tokens: 1 };
    expect(() => readAskSession('pipe', env)).toThrow();
    expect(() => appendAskSessionTurn('pipe', turn, env)).toThrow();
    expect(() => clearAskSession('pipe', env)).toThrow();
  });

  it('persists turns in jsonl and can clear session', () => {
    const base = mkdtempSync(join(tmpdir(), 'memphis-ask-session-'));
    const env = {
      ...process.env,
      ASK_SESSIONS_DIR: base,
      ASK_CONTEXT_TURNS: '10',
      ASK_CONTEXT_WINDOW_TOKENS: '200',
    };

    appendAskSessionTurn(
      'test',
      {
        timestamp: new Date().toISOString(),
        role: 'user',
        content: 'hello',
        tokens: estimateTokens('hello'),
      },
      env,
    );
    appendAskSessionTurn(
      'test',
      {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: 'hi',
        tokens: estimateTokens('hi'),
      },
      env,
    );

    const turns = readAskSession('test', env);
    expect(turns).toHaveLength(2);
    expect(askSessionPath('test', env)).toContain(base);

    clearAskSession('test', env);
    expect(readAskSession('test', env)).toHaveLength(0);
  });

  it('builds bounded context and runtime messages', () => {
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

    const messages = buildAskSessionMessages(context);
    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'second' });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'third' });
  });
});
