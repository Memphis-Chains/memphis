import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCorpus, type CorpusRow } from '../../src/cognitive/dreaming/corpus.js';
import {
  appendProposal,
  readProposals,
  transitionStoredProposal,
} from '../../src/cognitive/dreaming/proposal-chain.js';
import {
  createProposal,
  transitionProposal,
  type Proposal,
} from '../../src/cognitive/dreaming/proposal-lifecycle.js';
import { buildProposals } from '../../src/cognitive/dreaming/proposals.js';

/**
 * R2 — the proposals chain, the lifecycle, and the generator that fills it.
 *
 * The rules that matter are tested here, not just the plumbing:
 *
 *   1. A proposal without evidence is invalid.
 *   2. The gate's transitions are legal, and the rest are not.
 *   3. One bug is one proposal, however many signals describe it.
 *   4. The ids are stable, so a second scan writes nothing new.
 *
 * The live run is the falsifier: `npm run -s ops:dream-proposals`.
 */

const BASE: Omit<CorpusRow, 'session_id' | 'sequence' | 'role' | 'content'> = {
  tool_call_id: null,
  tool_name: null,
  tool_calls_json: null,
  provider: 'minimax',
  model: 'MiniMax-M3',
  created_at: '2026-11-03T10:00:00.000Z',
};

function assistantRow(
  sequence: number,
  calls: Array<{ id: string; name: string; args?: unknown }>,
  sessionId = 's1',
): CorpusRow {
  return {
    ...BASE,
    session_id: sessionId,
    sequence,
    role: 'assistant',
    content: '',
    tool_calls_json: JSON.stringify(
      calls.map((call) => ({ id: call.id, name: call.name, arguments: call.args ?? {} })),
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
const SILENT = { exitCode: 1 };

function turn(
  sequence: number,
  tool: string,
  outcome: Record<string, unknown>,
  args: unknown = { command: 'ls' },
): CorpusRow[] {
  const id = `c${sequence}`;
  return [
    assistantRow(sequence, [{ id, name: tool, args }]),
    toolRow(sequence + 1, id, tool, outcome),
  ];
}

describe('R2 · a proposal without evidence is invalid', () => {
  it('refuses to build a proposal without evidence', () => {
    expect(() =>
      createProposal({
        id: 'proposal:no-evidence',
        kind: 'memory.add',
        target: { scope: 'shared' },
        patch: {},
        evidence: [],
        prevalence: { occurrences: 3, sessions: 1, spanDays: 0, denominator: 3 },
        confidence: 0.6,
        rationale: 'because',
      }),
    ).toThrow(/no evidence/);
  });

  it('refuses a proposal with no occurrences', () => {
    expect(() =>
      createProposal({
        id: 'proposal:empty',
        kind: 'memory.add',
        target: { scope: 'shared' },
        patch: {},
        evidence: [{ sessionId: 's1', sequence: 1, quote: 'boom' }],
        prevalence: { occurrences: 0, sessions: 0, spanDays: 0, denominator: 3 },
        confidence: 0.6,
        rationale: 'because',
      }),
    ).toThrow(/no occurrences/);
  });
});

describe('R2 · the lifecycle', () => {
  const proposal = (): Proposal =>
    createProposal({
      id: 'proposal:test',
      kind: 'memory.add',
      target: { scope: 'shared' },
      patch: {},
      evidence: [{ sessionId: 's1', sequence: 1, quote: 'boom' }],
      prevalence: { occurrences: 3, sessions: 1, spanDays: 0, denominator: 3 },
      confidence: 0.6,
      rationale: 'because',
    });

  it('lets the operator accept a pending proposal', () => {
    const accepted = transitionProposal(proposal(), 'accepted');
    expect(accepted.status).toBe('accepted');
    expect(accepted.decidedAt).toBeDefined();
  });

  it('lets an accepted proposal be applied', () => {
    const accepted = transitionProposal(proposal(), 'accepted');
    const applied = transitionProposal(accepted, 'applied');
    expect(applied.status).toBe('applied');
    expect(applied.appliedAt).toBeDefined();
  });

  it('refuses to skip the gate', () => {
    expect(() => transitionProposal(proposal(), 'applied')).toThrow(/invalid transition/);
  });

  it('refuses to revive a rejected proposal', () => {
    const rejected = transitionProposal(proposal(), 'rejected');
    expect(() => transitionProposal(rejected, 'accepted')).toThrow(/invalid transition/);
  });
});

describe('R2 · one bug is one proposal', () => {
  it('merges every signal about an unknown tool into one proposal', () => {
    const rows: CorpusRow[] = [
      ...turn(1, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(3, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(5, 'mephis_exec', UNKNOWN_TOOL),
    ];
    const proposals = buildProposals(buildCorpus(rows));

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.id).toBe('proposal:unknown-tool');
    expect(proposals[0]?.prevalence.occurrences).toBe(3);
    expect(proposals[0]?.prevalence.denominator).toBe(3);
  });

  it('keeps a broken tool separate from the unknown-tool proposal', () => {
    const rows: CorpusRow[] = [
      ...turn(1, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(3, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(5, 'memphis_exec', FAIL),
      ...turn(7, 'memphis_exec', FAIL),
    ];
    const proposals = buildProposals(buildCorpus(rows));

    // Three claims, three proposals: the tool does not exist (twice said),
    // the tool is broken, and the same call keeps failing. "Broken tool"
    // and "repeat loop" are different facts about the same tool, and both
    // are true — only the unknown-tool class merges, because there the
    // six signals were one bug.
    expect(proposals.map((proposal) => proposal.id).sort()).toEqual([
      'proposal:broken-tool:memphis_exec',
      'proposal:repeat-loop:memphis_exec:5c1598102f78',
      'proposal:unknown-tool',
    ]);
  });

  it('reports a repeated failing call as a loop proposal', () => {
    const rows: CorpusRow[] = [...turn(1, 'memphis_exec', FAIL), ...turn(3, 'memphis_exec', FAIL)];
    const proposals = buildProposals(buildCorpus(rows));
    const loop = proposals.find((proposal) => proposal.id.startsWith('proposal:repeat-loop:'));

    expect(loop).toBeDefined();
    expect(loop?.prevalence.occurrences).toBe(2);
    expect(loop?.evidence.length).toBeGreaterThan(0);
  });

  it('does not propose a pattern seen once', () => {
    const rows: CorpusRow[] = [
      ...turn(1, 'memphis_exec', FAIL),
      ...turn(3, 'memphis_exec', OK),
    ];
    expect(buildProposals(buildCorpus(rows))).toHaveLength(0);
  });
});

describe('R2 · every proposal carries evidence and prevalence', () => {
  it('gives every proposal evidence, a prevalence and a confidence', () => {
    const rows: CorpusRow[] = [
      ...turn(1, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(3, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(5, 'memphis_exec', FAIL),
      ...turn(7, 'memphis_exec', FAIL),
      ...turn(9, 'memphis_exec', SILENT),
      ...turn(11, 'memphis_exec', SILENT),
    ];
    const proposals = buildProposals(buildCorpus(rows));

    expect(proposals.length).toBeGreaterThan(0);
    for (const proposal of proposals) {
      expect(proposal.evidence.length).toBeGreaterThan(0);
      expect(proposal.prevalence.occurrences).toBeGreaterThan(0);
      expect(proposal.prevalence.denominator).toBeGreaterThan(0);
      expect(proposal.confidence).toBeGreaterThan(0);
      expect(proposal.confidence).toBeLessThanOrEqual(0.95);
      expect(proposal.status).toBe('pending');
      expect(proposal.proposer).toBe('dreaming');
    }
  });

  it('gives the same ids on a second scan, so nothing is written twice', () => {
    const rows: CorpusRow[] = [
      ...turn(1, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(3, 'mephis_exec', UNKNOWN_TOOL),
      ...turn(5, 'memphis_exec', FAIL),
      ...turn(7, 'memphis_exec', FAIL),
    ];
    const turns = buildCorpus(rows);
    const first = buildProposals(turns);
    const second = buildProposals(turns);

    expect(second.map((proposal) => proposal.id)).toEqual(first.map((proposal) => proposal.id));
  });
});

describe('R2 · the proposals chain', () => {
  it('writes a proposal and reads it back', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-proposals-'));
    const rawEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      MEMPHIS_HOME: home,
      // The Rust chain writer resolves the chains directory from the
      // process environment, not from this one, so tests write through the
      // TypeScript fallback with the temporary home.
      RUST_CHAIN_ENABLED: 'false',
    };

    const proposal = createProposal({
      id: 'proposal:test',
      kind: 'memory.add',
      target: { scope: 'shared' },
      patch: { note: 'something' },
      evidence: [{ sessionId: 's1', sequence: 1, quote: 'boom' }],
      prevalence: { occurrences: 3, sessions: 1, spanDays: 0, denominator: 3 },
      confidence: 0.6,
      rationale: 'because',
    });

    await appendProposal(proposal, rawEnv);
    const stored = await readProposals(rawEnv);

    expect(stored).toHaveLength(1);
    expect(stored[0]?.id).toBe('proposal:test');
    expect(stored[0]?.evidence[0]?.quote).toBe('boom');
  });

  it('keeps the last state of a proposal, because the chain is append-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-proposals-'));
    const rawEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      MEMPHIS_HOME: home,
      RUST_CHAIN_ENABLED: 'false',
    };

    const proposal = createProposal({
      id: 'proposal:test',
      kind: 'memory.add',
      target: { scope: 'shared' },
      patch: {},
      evidence: [{ sessionId: 's1', sequence: 1, quote: 'boom' }],
      prevalence: { occurrences: 3, sessions: 1, spanDays: 0, denominator: 3 },
      confidence: 0.6,
      rationale: 'because',
    });

    await appendProposal(proposal, rawEnv);
    await transitionStoredProposal(proposal, 'rejected', rawEnv);

    const stored = await readProposals(rawEnv);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe('rejected');
    expect(stored[0]?.decidedAt).toBeDefined();
  });
});
