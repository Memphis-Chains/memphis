import { describe, expect, it } from 'vitest';

import { buildCorpus, type CorpusRow } from '../../src/cognitive/dreaming/corpus.js';
import {
  detectCorrections,
  detectNoProgress,
  detectRepeatLoops,
  detectSignals,
  detectToolFailureClusters,
  normalizeArgs,
  type DreamingSignal,
} from '../../src/cognitive/dreaming/signals.js';

/**
 * D2 — the detectors are deterministic, so every rule they claim can be
 * checked on a corpus small enough to read.
 *
 * The corpus here is built the way the runtime builds it: raw rows go
 * through `buildCorpus` first, so the signals are exercised over the
 * same shape they see in production (the outcome rides on the CALL,
 * not only on the tool turn). The live run is the falsifier:
 * `npm run -s ops:dream-signals`.
 */

const BASE: Omit<CorpusRow, 'session_id' | 'sequence' | 'role' | 'content'> = {
  tool_call_id: null,
  tool_name: null,
  tool_calls_json: null,
  provider: 'minimax',
  model: 'MiniMax-M3',
  created_at: '2026-11-02T10:00:00.000Z',
};

function userRow(text: string, sequence: number, sessionId = 's1'): CorpusRow {
  return {
    ...BASE,
    session_id: sessionId,
    sequence,
    role: 'user',
    content: `<user_input>\n${text}\n</user_input>`,
  };
}

function assistantRow(
  sequence: number,
  calls: Array<{ id: string; name: string; args?: unknown }>,
  text = '',
  sessionId = 's1',
): CorpusRow {
  return {
    ...BASE,
    session_id: sessionId,
    sequence,
    role: 'assistant',
    content: text,
    tool_calls_json: JSON.stringify(
      calls.map((c) => ({ id: c.id, name: c.name, arguments: c.args ?? {} })),
    ),
  };
}

function toolRow(
  sequence: number,
  callId: string,
  toolName: string,
  outcome: Record<string, unknown>,
  sessionId = 's1',
): CorpusRow {
  return {
    ...BASE,
    session_id: sessionId,
    sequence,
    role: 'tool',
    content: `<tool_output tool="${toolName}">\n${JSON.stringify(outcome)}\n</tool_output>`,
    tool_call_id: callId,
    tool_name: toolName,
  };
}

const OK = { ok: true };
const FAIL = { error: 'boom' };
const UNKNOWN_TOOL = { error: 'unsupported native rust chat tool: mephis_exec' };

describe('S1 · tool-failure-cluster', () => {
  it('reports a tool that keeps failing, with the population it was measured against', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'memphis_exec' }]),
      toolRow(2, 'c1', 'memphis_exec', FAIL),
      assistantRow(3, [{ id: 'c2', name: 'memphis_exec' }]),
      toolRow(4, 'c2', 'memphis_exec', FAIL),
      assistantRow(5, [{ id: 'c3', name: 'memphis_exec' }]),
      toolRow(6, 'c3', 'memphis_exec', OK),
    ]);

    const signals = detectToolFailureClusters(turns);
    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal?.kind).toBe('tool-failure-cluster');
    expect(signal?.prevalence.occurrences).toBe(2);
    expect(signal?.prevalence.denominator).toBe(3);
    expect(signal?.evidence[0]?.quote).toContain('boom');
  });

  it('does not report a tool that failed once', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'memphis_exec' }]),
      toolRow(2, 'c1', 'memphis_exec', FAIL),
    ]);
    expect(detectToolFailureClusters(turns)).toHaveLength(0);
  });

  it('reads the severity from the failure RATE, not from the volume', () => {
    const build = (failures: number, total: number) => {
      const rows: CorpusRow[] = [];
      for (let i = 0; i < total; i += 1) {
        const id = `c${i}`;
        rows.push(assistantRow(i * 2 + 1, [{ id, name: 'memphis_exec' }]));
        rows.push(toolRow(i * 2 + 2, id, 'memphis_exec', i < failures ? FAIL : OK));
      }
      return buildCorpus(rows);
    };

    expect(detectToolFailureClusters(build(2, 2))[0]?.severity).toBe('high');
    expect(detectToolFailureClusters(build(3, 10))[0]?.severity).toBe('medium');
    expect(detectToolFailureClusters(build(2, 40))[0]?.severity).toBe('low');
  });

  it('recognises a tool the runtime does not know, from the error alone', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'mephis_exec' }]),
      toolRow(2, 'c1', 'mephis_exec', UNKNOWN_TOOL),
    ]);

    const signal = detectToolFailureClusters(turns)[0];
    expect(signal?.summary).toContain('does not exist');
    expect(signal?.summary).toContain('mephis_exec');
  });

  it('keeps at most three evidence items', () => {
    const rows: CorpusRow[] = [];
    for (let i = 0; i < 9; i += 1) {
      const id = `c${i}`;
      rows.push(assistantRow(i * 2 + 1, [{ id, name: 'memphis_exec' }]));
      rows.push(toolRow(i * 2 + 2, id, 'memphis_exec', FAIL));
    }
    expect(detectToolFailureClusters(buildCorpus(rows))[0]?.evidence).toHaveLength(3);
  });
});

describe('S2 · repeat-loop', () => {
  it('reports the same call failing again', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'memphis_exec', args: { command: 'ls' } }]),
      toolRow(2, 'c1', 'memphis_exec', FAIL),
      assistantRow(3, [{ id: 'c2', name: 'memphis_exec', args: { command: 'ls' } }]),
      toolRow(4, 'c2', 'memphis_exec', FAIL),
      assistantRow(5, [{ id: 'c3', name: 'memphis_exec', args: { command: 'ls' } }]),
      toolRow(6, 'c3', 'memphis_exec', FAIL),
    ]);

    const signals = detectRepeatLoops(turns);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.prevalence.occurrences).toBe(3);
    expect(signals[0]?.severity).toBe('medium');
  });

  it('does not report two different calls as a loop', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'memphis_exec', args: { command: 'ls' } }]),
      toolRow(2, 'c1', 'memphis_exec', FAIL),
      assistantRow(3, [{ id: 'c2', name: 'memphis_exec', args: { command: 'pwd' } }]),
      toolRow(4, 'c2', 'memphis_exec', FAIL),
    ]);
    expect(detectRepeatLoops(turns)).toHaveLength(0);
  });

  it('treats the same call with different whitespace and key order as one call', () => {
    expect(normalizeArgs({ command: 'ls  -l', flag: true })).toBe(
      normalizeArgs({ flag: true, command: 'ls -l' }),
    );

    const turns = buildCorpus([
      assistantRow(1, [
        { id: 'c1', name: 'memphis_exec', args: { command: 'ls  -l', flag: true } },
      ]),
      toolRow(2, 'c1', 'memphis_exec', FAIL),
      assistantRow(3, [{ id: 'c2', name: 'memphis_exec', args: { flag: true, command: 'ls -l' } }]),
      toolRow(4, 'c2', 'memphis_exec', FAIL),
    ]);
    expect(detectRepeatLoops(turns)).toHaveLength(1);
  });

  it('counts the successful identical calls in the denominator', () => {
    const turns = buildCorpus([
      assistantRow(1, [{ id: 'c1', name: 'memphis_chain_verify', args: {} }]),
      toolRow(2, 'c1', 'memphis_chain_verify', FAIL),
      assistantRow(3, [{ id: 'c2', name: 'memphis_chain_verify', args: {} }]),
      toolRow(4, 'c2', 'memphis_chain_verify', OK),
      assistantRow(5, [{ id: 'c3', name: 'memphis_chain_verify', args: {} }]),
      toolRow(6, 'c3', 'memphis_chain_verify', FAIL),
    ]);

    const signal = detectRepeatLoops(turns)[0];
    expect(signal?.prevalence.occurrences).toBe(2);
    expect(signal?.prevalence.denominator).toBe(3);
  });
});

describe('S3 · correction', () => {
  it('reports a correction, and says how sparse the signal is', () => {
    const turns = buildCorpus([userRow('nietrzeba', 1), userRow('nic z tego nie rozumiem', 2)]);
    const signals = detectCorrections(turns);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe('low');
    expect(signals[0]?.prevalence.occurrences).toBe(2);
    expect(signals[0]?.prevalence.denominator).toBe(2);
    expect(signals[0]?.summary).toContain('D5');
  });

  it('does not treat a question as a complaint', () => {
    expect(detectCorrections(buildCorpus([userRow('co wisi?', 1)]))).toHaveLength(0);
  });

  it('matches on word boundaries, so a longer word does not trigger it', () => {
    // "aktywnie dzialam" contains "nie dziala" as a substring — the
    // marker must not fire on it.
    const turns = buildCorpus([userRow('komunikuje, ze aktywnie dzialam ze szczepan dyduch', 1)]);
    expect(detectCorrections(turns)).toHaveLength(0);
  });

  it('reports nothing when nothing matches', () => {
    const turns = buildCorpus([userRow('ok', 1), userRow('dzien dobry', 2)]);
    expect(detectCorrections(turns)).toHaveLength(0);
  });
});

describe('S4 · no-progress', () => {
  const buildSession = (toolOnlyTurns: number, proseTurns: number, toolCalls: number) => {
    const rows: CorpusRow[] = [];
    let sequence = 1;
    for (let i = 0; i < toolOnlyTurns; i += 1) {
      rows.push(assistantRow(sequence, [{ id: `t${i}`, name: 'memphis_exec' }], ''));
      sequence += 1;
    }
    for (let i = 0; i < proseTurns; i += 1) {
      rows.push({
        ...BASE,
        session_id: 's1',
        sequence,
        role: 'assistant',
        content: 'a sentence for the operator',
      });
      sequence += 1;
    }
    for (let i = 0; i < toolCalls; i += 1) {
      rows.push(toolRow(sequence, `r${i}`, 'memphis_exec', OK));
      sequence += 1;
    }
    return buildCorpus(rows);
  };

  it('reports a session whose assistant turns are work without narration', () => {
    const signals = detectNoProgress(buildSession(18, 2, 25));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.kind).toBe('no-progress');
    expect(signals[0]?.prevalence.occurrences).toBe(18);
    expect(signals[0]?.prevalence.denominator).toBe(20);
  });

  it('does not report a session that narrates', () => {
    expect(detectNoProgress(buildSession(5, 15, 25))).toHaveLength(0);
  });

  it('does not report a short session on the share alone', () => {
    expect(detectNoProgress(buildSession(8, 0, 4))).toHaveLength(0);
  });
});

describe('detectSignals', () => {
  it('runs every detector and returns them together', () => {
    const turns = buildCorpus([
      userRow('nietrzeba', 1),
      assistantRow(2, [{ id: 'c1', name: 'memphis_exec' }]),
      toolRow(3, 'c1', 'memphis_exec', FAIL),
      assistantRow(4, [{ id: 'c2', name: 'memphis_exec' }]),
      toolRow(5, 'c2', 'memphis_exec', FAIL),
    ]);

    const signals: DreamingSignal[] = detectSignals(turns);
    const kinds = new Set(signals.map((signal) => signal.kind));
    expect(kinds.has('tool-failure-cluster')).toBe(true);
    expect(kinds.has('repeat-loop')).toBe(true);
    expect(kinds.has('correction')).toBe(true);
  });
});
