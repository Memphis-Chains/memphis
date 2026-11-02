import { describe, expect, it } from 'vitest';

import {
  buildCorpus,
  classifyOutcome,
  corpusStats,
  parseCalls,
  stripEnvelope,
  type CorpusRow,
} from '../../src/cognitive/dreaming/corpus.js';

/**
 * D1 — the corpus builder is pure, so every rule it claims can be
 * checked without a database.
 *
 * The rules are not stylistic. They are the three measurements that
 * the design document turned into code:
 *
 *   1. every user turn and every tool result is wrapped, and the
 *      wrapper has to come off or the detector matches the envelope
 *      instead of the speech;
 *   2. the closing tag has two spellings, and one of them is rare
 *      enough that a parser that only knows the common one loses rows
 *      silently;
 *   3. the body may quote the wrapper, so the strip must cut at the
 *      LAST closing tag.
 *
 * And the one rule that keeps a failing tool result attached to the
 * call that caused it: an ambiguous call id must not acquire another
 * call's outcome.
 */

describe('stripEnvelope', () => {
  it('removes the user wrapper', () => {
    expect(stripEnvelope('<user_input>\nniesamowite\n</user_input>')).toEqual({
      text: 'niesamowite',
      toolName: undefined,
      wrapped: true,
    });
  });

  it('removes the tool wrapper and reads the tool name out of it', () => {
    expect(
      stripEnvelope('<tool_output tool="memphis_health">\n{"ok":true}\n</tool_output>'),
    ).toEqual({
      text: '{"ok":true}',
      toolName: 'memphis_health',
      wrapped: true,
    });
  });

  it('handles the escaped closing tag, which the harness writes when the tool output quotes the wrapper', () => {
    const raw =
      '<tool_output tool="memphis_exec">\ngrep -i error <<\\/tool_output>>\n</tool_output>';
    const result = stripEnvelope(raw);
    expect(result.wrapped).toBe(true);
    expect(result.text).toContain('<\\/tool_output>');
    expect(result.text).not.toContain('<tool_output');
  });

  it('cuts at the LAST closing tag, because the body may quote the wrapper', () => {
    const raw = '<tool_output tool="memphis_exec">he said </tool_output> here</tool_output>';
    const result = stripEnvelope(raw);
    expect(result.wrapped).toBe(true);
    expect(result.text).toBe('he said </tool_output> here');
  });

  it('leaves an unwrapped message alone', () => {
    expect(stripEnvelope('a plain answer')).toEqual({
      text: 'a plain answer',
      toolName: undefined,
      wrapped: false,
    });
  });

  it('does not cut a message it does not recognise', () => {
    expect(stripEnvelope('<other>x</other>')).toEqual({
      text: '<other>x</other>',
      toolName: undefined,
      wrapped: false,
    });
  });
});

describe('classifyOutcome', () => {
  it('reads a non-zero exit code as a failure', () => {
    const outcome = classifyOutcome('{"exitCode":1}');
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(1);
  });

  it('reads an error field as a failure', () => {
    expect(classifyOutcome('{"error":"boom"}').ok).toBe(false);
  });

  it('reads ok:false, blocked:true and status:error as failures', () => {
    expect(classifyOutcome('{"ok":false}').ok).toBe(false);
    expect(classifyOutcome('{"blocked":true}').ok).toBe(false);
    expect(classifyOutcome('{"status":"error"}').ok).toBe(false);
  });

  it('reads a clean envelope as a success', () => {
    const outcome = classifyOutcome('{"exitCode":0,"ok":true}');
    expect(outcome.ok).toBe(true);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.payload).toEqual({ exitCode: 0, ok: true });
  });

  it('does not call a result that merely mentions an error a failure', () => {
    // The measured trap: a naive substring scan flags 670 results
    // where the structural check finds 255. The word "error" is usually
    // in the COMMAND, not in the outcome.
    expect(classifyOutcome('{"stdout":"grep -i error access.log"}').ok).toBe(true);
    expect(classifyOutcome('{"message":"chain \'journal\' not found"}').ok).toBe(true);
  });

  it('treats an unparseable result as unknown, never as success', () => {
    expect(classifyOutcome('not json').ok).toBeNull();
    expect(classifyOutcome('').ok).toBeNull();
    expect(classifyOutcome('[]').ok).toBeNull();
    expect(classifyOutcome('null').ok).toBeNull();
  });
});

describe('parseCalls', () => {
  it('reads the calls out of the assistant row', () => {
    const calls = parseCalls('[{"id":"call_1","name":"memphis_exec","arguments":{"cmd":"ls"}}]');
    expect(calls).toEqual([{ id: 'call_1', name: 'memphis_exec', args: { cmd: 'ls' } }]);
  });

  it('skips entries that carry no id or no name', () => {
    expect(parseCalls('[{"name":"memphis_exec"},{"id":"call_1"}]')).toEqual([]);
  });

  it('skips entries that are not objects', () => {
    expect(parseCalls('[null,7,"x",{"id":"call_1","name":"memphis_health"}]')).toEqual([
      { id: 'call_1', name: 'memphis_health', args: undefined },
    ]);
  });

  it('returns nothing for a malformed or non-array payload', () => {
    expect(parseCalls('not json')).toEqual([]);
    expect(parseCalls('{"id":"call_1"}')).toEqual([]);
    expect(parseCalls(null)).toEqual([]);
    expect(parseCalls('')).toEqual([]);
  });
});

describe('buildCorpus', () => {
  const base: Omit<CorpusRow, 'session_id' | 'sequence' | 'role' | 'content'> = {
    tool_call_id: null,
    tool_name: null,
    tool_calls_json: null,
    provider: 'minimax',
    model: 'MiniMax-M3',
    created_at: '2026-11-02T10:00:00.000Z',
  };

  const assistant = (over: Partial<CorpusRow>): CorpusRow => ({
    ...base,
    session_id: 's1',
    sequence: 1,
    role: 'assistant',
    content: '',
    ...over,
  });

  const toolRow = (over: Partial<CorpusRow>): CorpusRow => ({
    ...base,
    session_id: 's1',
    sequence: 2,
    role: 'tool',
    content: '<tool_output tool="memphis_exec">\n{"ok":true}\n</tool_output>',
    ...over,
  });

  it('attaches the result of a call to the call that made it', () => {
    const turns = buildCorpus([
      assistant({
        sequence: 1,
        content: 'working on it',
        tool_calls_json: '[{"id":"call_1","name":"memphis_exec","arguments":{"cmd":"ls"}}]',
      }),
      toolRow({ sequence: 2, tool_call_id: 'call_1', tool_name: 'memphis_exec' }),
    ]);

    const assistantTurn = turns.find((turn) => turn.role === 'assistant');
    expect(assistantTurn?.calls).toHaveLength(1);
    expect(assistantTurn?.calls?.[0]?.outcome?.ok).toBe(true);

    const toolTurn = turns.find((turn) => turn.role === 'tool');
    expect(toolTurn?.outcome?.ok).toBe(true);
    expect(toolTurn?.toolCallId).toBe('call_1');
  });

  it('refuses to attach an outcome to an ambiguous call id', () => {
    // Two calls in the same session share an id. Either one of them
    // could be the call that produced the result, so the result must
    // not be attached to either.
    const turns = buildCorpus([
      assistant({
        sequence: 1,
        tool_calls_json: '[{"id":"call_dup","name":"memphis_exec","arguments":{}}]',
      }),
      assistant({
        sequence: 2,
        tool_calls_json: '[{"id":"call_dup","name":"memphis_grep","arguments":{}}]',
      }),
      toolRow({ sequence: 3, tool_call_id: 'call_dup' }),
    ]);

    const assistantTurns = turns.filter((turn) => turn.role === 'assistant');
    expect(assistantTurns).toHaveLength(2);
    for (const turn of assistantTurns) {
      expect(turn.calls?.[0]?.outcome).toBeUndefined();
    }
  });

  it('does not attach a result that precedes the call', () => {
    const turns = buildCorpus([
      toolRow({ sequence: 1, tool_call_id: 'call_1' }),
      assistant({
        sequence: 2,
        tool_calls_json: '[{"id":"call_1","name":"memphis_exec","arguments":{}}]',
      }),
    ]);

    const assistantTurn = turns.find((turn) => turn.role === 'assistant');
    expect(assistantTurn?.calls?.[0]?.outcome).toBeUndefined();
  });

  it('does not join a result from another session', () => {
    const turns = buildCorpus([
      assistant({
        session_id: 's1',
        sequence: 1,
        tool_calls_json: '[{"id":"call_1","name":"memphis_exec","arguments":{}}]',
      }),
      toolRow({ session_id: 's2', sequence: 2, tool_call_id: 'call_1' }),
    ]);

    const assistantTurn = turns.find((turn) => turn.role === 'assistant');
    expect(assistantTurn?.calls?.[0]?.outcome).toBeUndefined();
  });

  it('drops a row whose role it does not recognise', () => {
    const turns = buildCorpus([
      { ...base, session_id: 's1', sequence: 1, role: 'system', content: 'internal' },
    ]);
    expect(turns).toHaveLength(0);
  });
});

describe('corpusStats', () => {
  it('counts turns, sessions, calls and the wrapper split', () => {
    const rows: CorpusRow[] = [
      {
        session_id: 's1',
        sequence: 1,
        role: 'user',
        content: '<user_input>\nhi\n</user_input>',
        tool_call_id: null,
        tool_name: null,
        tool_calls_json: null,
        provider: null,
        model: null,
        created_at: '2026-11-02T10:00:00.000Z',
      },
      {
        session_id: 's1',
        sequence: 2,
        role: 'assistant',
        content: 'on it',
        tool_call_id: null,
        tool_name: null,
        tool_calls_json: '[{"id":"call_1","name":"memphis_exec","arguments":{}}]',
        provider: 'minimax',
        model: 'MiniMax-M3',
        created_at: '2026-11-02T10:00:01.000Z',
      },
      {
        session_id: 's1',
        sequence: 3,
        role: 'tool',
        content: '<tool_output tool="memphis_exec">\n{"error":"boom"}\n</tool_output>',
        tool_call_id: 'call_1',
        tool_name: 'memphis_exec',
        tool_calls_json: null,
        provider: null,
        model: null,
        created_at: '2026-11-02T10:00:02.000Z',
      },
    ];

    const stats = corpusStats(buildCorpus(rows), rows);
    expect(stats.turns).toBe(3);
    expect(stats.sessions).toBe(1);
    expect(stats.userTurns).toBe(1);
    expect(stats.assistantTurns).toBe(1);
    expect(stats.toolTurns).toBe(1);
    expect(stats.calls).toBe(1);
    expect(stats.callsWithOutcome).toBe(1);
    expect(stats.failures).toBe(1);
    expect(stats.unknownOutcomes).toBe(0);
    expect(stats.unparsed).toBe(0);
    // user + tool are wrapped, the assistant turn is not
    expect(stats.wrapped).toBe(2);
  });

  it('reports an empty corpus as empty, not as an error', () => {
    const stats = corpusStats([], []);
    expect(stats.turns).toBe(0);
    expect(stats.sessions).toBe(0);
    expect(stats.failures).toBe(0);
  });
});
