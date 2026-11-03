/**
 * From signals to proposals.
 *
 * WHAT THIS DOES
 * --------------
 * The D2 detectors (`signals.ts`) answer "what happened". This module turns
 * that into "here is a change worth making", and it does it WITHOUT
 * inventing a second opinion: the detectors decide WHICH patterns exist,
 * and the corpus is counted for the exact numbers each proposal carries.
 *
 * ONE PROPOSAL PER BUG, NOT PER SIGNAL
 * ------------------------------------
 * The operator's decision (2026-11-03): a proposal is a bug, not a
 * signal. Measured on the live corpus, 6 of the 26 signals are one bug —
 * the agent calls tool names the runtime does not know (`mephis_exec`
 * instead of `memphis_exec`), which produced 56 failed calls in 3
 * sessions. Six proposals would have said the same thing six times.
 * Merging by root cause gives **21** proposals instead of 26, and the
 * merged one carries the whole 56.
 *
 * The root cause is never guessed: it is read off the evidence. The
 * runtime says which tool it did not know ("unsupported native rust chat
 * tool: X"), so that error IS the cause, and every signal about that tool
 * folds into it.
 *
 * MEASURED ON THE LIVE CORPUS (2026-11-03, 8 437 tool results, 45
 * sessions, 17 132 turns)
 * -----------------------------------------------------
 *   signals                              26
 *   proposals after merging by cause     21
 *   signals without evidence             0
 *   proposals below the occurrence floor 0
 */

import { createHash } from 'node:crypto';

import type { DreamingTurn } from './corpus.js';
import {
  createProposal,
  type Proposal,
  type ProposalEvidence,
  type ProposalKind,
} from './proposal-lifecycle.js';
import { detectSignals, normalizeArgs, type DreamingSignal } from './signals.js';

/**
 * The runtime's own words for "this tool does not exist". It names the
 * tool, which is why it is the root cause and not a symptom.
 */
export const UNKNOWN_TOOL_RE = /unsupported native rust chat tool:\s*(\S+)/;

/**
 * How many evidence items one proposal carries. Enough to judge it, not
 * enough to drown in — the same rule the signals themselves follow.
 */
export const MAX_PROPOSAL_EVIDENCE = 6;

/**
 * How many sessions a proposal names in `basedOn`.
 */
export const MAX_BASED_ON_SESSIONS = 20;

/**
 * One is an accident, a handful is a pattern. The same floor the cluster
 * detector uses.
 */
export const MIN_PROPOSAL_OCCURRENCES = 2;

/**
 * The deterministic tier has no probability model, so `confidence` is the
 * severity the detector already computed FROM THE RATE, mapped to a
 * number. Claiming more precision than that would be the hubris this
 * repo is careful about.
 */
const CONFIDENCE_BY_SEVERITY = { high: 0.9, medium: 0.6, low: 0.3 } as const;

interface CallRecord {
  name: string;
  args: string;
  classification: string;
  sessionId: string;
  at: number;
  error?: string;
  quote: string;
  sequence: number;
}

interface RootCause {
  key: string;
  id: string;
  kind: ProposalKind;
  scope: string;
  tool?: string;
  args?: string;
  sessionId?: string;
  signals: DreamingSignal[];
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 12);
}

function collectCalls(turns: DreamingTurn[]): CallRecord[] {
  const records: CallRecord[] = [];
  for (const turn of turns) {
    for (const call of turn.calls ?? []) {
      records.push({
        name: call.name,
        args: normalizeArgs(call.args),
        classification: call.outcome?.classification ?? 'unknown',
        sessionId: turn.sessionId,
        at: Date.parse(turn.at),
        error: call.outcome?.error,
        quote: call.outcome?.error ?? call.outcome?.reason ?? call.name,
        sequence: turn.sequence,
      });
    }
  }
  return records;
}

/** The tool names the runtime said it did not know. */
function collectUnknownToolNames(records: CallRecord[]): Set<string> {
  const names = new Set<string>();
  for (const record of records) {
    const match = UNKNOWN_TOOL_RE.exec(record.error ?? '');
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function unknownToolCause(): RootCause {
  return {
    key: 'unknown-tool',
    id: 'proposal:unknown-tool',
    kind: 'org.directive',
    scope: 'org',
    signals: [],
  };
}

function rootCauseFor(signal: DreamingSignal, unknownToolNames: Set<string>): RootCause | null {
  if (signal.kind === 'tool-failure-cluster') {
    const tool = signal.id.slice('tool-failure-cluster:'.length);
    if (unknownToolNames.has(tool)) return unknownToolCause();
    return {
      key: `broken-tool:${tool}`,
      id: `proposal:broken-tool:${tool}`,
      kind: 'memory.add',
      scope: 'shared',
      tool,
      signals: [],
    };
  }
  if (signal.kind === 'repeat-loop') {
    const rest = signal.id.slice('repeat-loop:'.length);
    const separator = rest.indexOf('|');
    const tool = separator === -1 ? rest : rest.slice(0, separator);
    const args = separator === -1 ? '' : rest.slice(separator + 1);
    if (unknownToolNames.has(tool)) return unknownToolCause();
    const hash = shortHash(`${tool}|${args}`);
    return {
      key: `repeat-loop:${tool}:${hash}`,
      id: `proposal:repeat-loop:${tool}:${hash}`,
      kind: 'org.directive',
      scope: 'org',
      tool,
      args,
      signals: [],
    };
  }
  if (signal.kind === 'correction') {
    return {
      key: 'correction:operator-dissatisfaction',
      id: 'proposal:correction:operator-dissatisfaction',
      kind: 'org.directive',
      scope: 'org',
      signals: [],
    };
  }
  if (signal.kind === 'no-progress') {
    const sessionId = signal.id.slice('no-progress:'.length);
    return {
      key: `no-progress:${sessionId}`,
      id: `proposal:no-progress:${sessionId}`,
      kind: 'memory.add',
      scope: 'personal',
      sessionId,
      signals: [],
    };
  }
  return null;
}

/**
 * The exact numbers, counted from the corpus rather than summed from the
 * signals. Summing would double-count: one call can be in a cluster signal
 * AND in a repeat-loop signal, and the merged group's own numbers have to
 * be true on their own.
 */
function prevalenceFor(
  root: RootCause,
  records: CallRecord[],
  unknownToolNames: Set<string>,
): Proposal['prevalence'] | null {
  if (root.key === 'unknown-tool') {
    const events = records.filter((record) => UNKNOWN_TOOL_RE.test(record.error ?? ''));
    const denominator = records.filter((record) => unknownToolNames.has(record.name)).length;
    return buildPrevalence(events, denominator);
  }
  if (root.tool && root.kind === 'memory.add' && root.key.startsWith('broken-tool:')) {
    const events = records.filter(
      (record) => record.name === root.tool && record.classification === 'failure',
    );
    const denominator = records.filter((record) => record.name === root.tool).length;
    return buildPrevalence(events, denominator);
  }
  if (root.tool && root.args !== undefined) {
    const events = records.filter(
      (record) =>
        record.name === root.tool &&
        record.args === root.args &&
        (record.classification === 'failure' || record.classification === 'inconclusive'),
    );
    const denominator = records.filter(
      (record) => record.name === root.tool && record.args === root.args,
    ).length;
    return buildPrevalence(events, denominator);
  }
  // Turn-level signals (correction, no-progress) already carry their own
  // population, and there is no call to count.
  const signal = root.signals[0];
  return signal ? { ...signal.prevalence } : null;
}

function buildPrevalence(events: CallRecord[], denominator: number): Proposal['prevalence'] | null {
  if (events.length === 0 || denominator <= 0) return null;
  const sessions = new Set(events.map((event) => event.sessionId));
  const times = events.map((event) => event.at).filter((at) => !Number.isNaN(at));
  const spanDays =
    times.length === 0 ? 0 : Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000);
  return {
    occurrences: events.length,
    sessions: sessions.size,
    spanDays: spanDays < 1 ? 0 : spanDays,
    denominator,
  };
}

function severityFor(rate: number): 'low' | 'medium' | 'high' {
  if (rate >= 0.5) return 'high';
  if (rate >= 0.1) return 'medium';
  return 'low';
}

function mergeEvidence(signals: DreamingSignal[]): ProposalEvidence[] {
  const merged: ProposalEvidence[] = [];
  const seen = new Set<string>();
  for (const signal of signals) {
    for (const item of signal.evidence) {
      const key = `${item.sessionId}:${item.sequence}:${item.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        sessionId: item.sessionId,
        sequence: item.sequence,
        quote: item.quote,
        ...(item.toolName ? { toolName: item.toolName } : {}),
      });
      if (merged.length >= MAX_PROPOSAL_EVIDENCE) return merged;
    }
  }
  return merged;
}

function commandOf(args: string | undefined): string | undefined {
  if (!args) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const command = (parsed as Record<string, unknown>).command;
      if (typeof command === 'string') return command;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function describe(
  root: RootCause,
  prevalence: Proposal['prevalence'],
  unknownToolNames: Set<string>,
): { patch: Record<string, unknown>; rationale: string } {
  const rate = prevalence.occurrences / prevalence.denominator;
  const percent = `${(rate * 100).toFixed(1)} %`;

  if (root.key === 'unknown-tool') {
    const names = [...unknownToolNames].sort();
    return {
      patch: {
        note: `Do not call tool names this runtime does not know: ${names.join(', ')}.`,
        toolNames: names,
      },
      rationale: `The agent called ${names.length} tool name(s) the runtime does not know, ${prevalence.occurrences} times across ${prevalence.sessions} session(s). Every one of those calls was answered with "unsupported native rust chat tool".`,
    };
  }
  if (root.key.startsWith('broken-tool:')) {
    return {
      patch: {
        note: `Tool "${root.tool}" failed ${prevalence.occurrences} of ${prevalence.denominator} calls (${percent}).`,
        tool: root.tool,
      },
      rationale: `Tool "${root.tool}" failed ${prevalence.occurrences} of ${prevalence.denominator} calls (${percent}) across ${prevalence.sessions} session(s).`,
    };
  }
  if (root.key.startsWith('repeat-loop:')) {
    const command = commandOf(root.args);
    return {
      patch: {
        note: `Do not repeat a call that has already failed: ${root.tool}${command ? ` ${command}` : ''}.`,
        tool: root.tool,
        ...(command ? { command } : {}),
      },
      rationale: `The same "${root.tool}" call did not succeed ${prevalence.occurrences} times across ${prevalence.sessions} session(s) (${prevalence.denominator} identical calls in total).`,
    };
  }
  if (root.key.startsWith('correction:')) {
    return {
      patch: {
        note: 'The operator said this went wrong. Do not do it again.',
      },
      rationale: `The operator expressed dissatisfaction in ${prevalence.occurrences} of ${prevalence.denominator} user turns across ${prevalence.sessions} session(s).`,
    };
  }
  return {
    patch: {
      note: `Session ${root.sessionId} made ${prevalence.occurrences} tool calls without concluding.`,
      sessionId: root.sessionId,
    },
    rationale: `Session ${root.sessionId} made ${prevalence.occurrences} tool calls across ${prevalence.denominator} assistant turns without an answer.`,
  };
}
/**
 * Build the proposals the corpus yields.
 *
 * The detectors decide which patterns exist; the corpus is counted for the
 * exact numbers; the operator's gate decides what happens next.
 */
export function buildProposals(
  turns: DreamingTurn[],
  nowIso: string = new Date().toISOString(),
  signals: DreamingSignal[] = detectSignals(turns),
): Proposal[] {
  const records = collectCalls(turns);
  const unknownToolNames = collectUnknownToolNames(records);

  const groups = new Map<string, RootCause>();
  for (const signal of signals) {
    const root = rootCauseFor(signal, unknownToolNames);
    if (!root) continue;
    const existing = groups.get(root.key);
    if (existing) existing.signals.push(signal);
    else groups.set(root.key, { ...root, signals: [signal] });
  }

  const proposals: Proposal[] = [];
  for (const root of groups.values()) {
    const prevalence = prevalenceFor(root, records, unknownToolNames);
    if (!prevalence || prevalence.occurrences < MIN_PROPOSAL_OCCURRENCES) continue;
    const rate = prevalence.occurrences / prevalence.denominator;
    const severity = severityFor(rate);
    const { patch, rationale } = describe(root, prevalence, unknownToolNames);
    const sessionIds = [
      ...new Set(root.signals.flatMap((signal) => signal.evidence.map((item) => item.sessionId))),
    ].slice(0, MAX_BASED_ON_SESSIONS);

    proposals.push(
      createProposal({
        id: root.id,
        kind: root.kind,
        target: { scope: root.scope, ...(root.tool ? { id: root.tool } : {}) },
        patch,
        evidence: mergeEvidence(root.signals),
        prevalence,
        confidence: CONFIDENCE_BY_SEVERITY[severity],
        rationale,
        basedOn: { sessionIds, chainBlockHashes: [] },
        nowIso,
      }),
    );
  }

  return proposals.sort(
    (a, b) => b.prevalence.occurrences - a.prevalence.occurrences || a.id.localeCompare(b.id),
  );
}

/**
 * The signals behind the proposals, for the falsifier and for `dream show`.
 */
export function buildProposalsWithSignals(
  turns: DreamingTurn[],
  nowIso: string = new Date().toISOString(),
): { proposals: Proposal[]; signals: DreamingSignal[] } {
  const signals = detectSignals(turns);
  return { proposals: buildProposals(turns, nowIso, signals), signals };
}
