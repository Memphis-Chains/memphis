/**
 * D2 — the deterministic signals.
 *
 * WHY THIS EXISTS
 * ---------------
 * The corpus (`src/cognitive/dreaming/corpus.ts`) is the raw material;
 * this module is what looks at it. Four detectors, no LLM, no tokens,
 * always on. Each one answers a question about how the agent actually
 * worked, not about how it says it worked.
 *
 *   S1 · tool-failure-cluster — a tool that keeps failing
 *   S2 · repeat-loop           — the same call, failing again
 *   S3 · correction            — the operator saying it went wrong
 *   S4 · no-progress           — the agent working without concluding
 *
 * THE RULES THE MEASUREMENT FORCED
 * --------------------------------
 * 1. A failure is a STRUCTURED fact. The envelope decides
 *    (`exitCode`, `error`, `ok:false`, `blocked:true`, `status:error`),
 *    never the text. On the live corpus a substring scan for "error"
 *    flags 1 219 results that are fine and misses 190 real failures.
 *
 * 2. An unknown tool is a STRUCTURED fact too, and it is the exact
 *    inverse of a guess about which tool names exist: the runtime says
 *    which one it did not know, in the error itself
 *    ("unsupported native rust chat tool: X"). A hand-written list of
 *    valid tool names is wrong the moment a tool is added — and when
 *    this module was first written, such a list produced 56 where the
 *    truth was 56 only by accident, and would have produced 58 if two
 *    real tools had been mistaken for typos.
 *
 * 3. "Repeated" means the same NORMALIZED arguments, not the same
 *    text. Whitespace and key order are noise; the command is not.
 *
 * 4. S3 is measured to be nearly empty (a handful of turns out of
 *    ~600), and keyword matching is not precise enough to carry a
 *    memory decision. This module therefore reports it as LOW severity
 *    and says so in the summary — the signal belongs to the LLM tier
 *    (D5), and the honest thing is to publish the count, not to dress
 *    it up.
 *
 * WHAT A SIGNAL IS NOT
 * --------------------
 * A signal is not a verdict. It says "here is a pattern, here is the
 * evidence, here is how prevalent it is". The human decides whether it
 * deserves a memory change (that gate is D4). Everything here is
 * deterministic so that the same corpus always produces the same
 * signals.
 */

import type { DreamingTurn } from './corpus.js';

export type DreamingSignalKind =
  | 'tool-failure-cluster'
  | 'repeat-loop'
  | 'correction'
  | 'no-progress'
  | 'stale-memory';

export type DreamingSeverity = 'low' | 'medium' | 'high';

export interface DreamingSignalEvidence {
  sessionId: string;
  sequence: number;
  /** The text that shows the pattern. Never the whole transcript. */
  quote: string;
  toolName?: string;
}

export interface DreamingSignalPrevalence {
  /** How many times the pattern occurred. */
  occurrences: number;
  /** How many distinct sessions it occurred in. */
  sessions: number;
  /** Days between the first and the last occurrence (0 = same day). */
  spanDays: number;
  /** The population it was measured against (calls to the tool, user turns…). */
  denominator: number;
}

export interface DreamingSignal {
  id: string;
  kind: DreamingSignalKind;
  severity: DreamingSeverity;
  summary: string;
  evidence: DreamingSignalEvidence[];
  prevalence: DreamingSignalPrevalence;
}

/** The runtime's own words for "I do not know this tool". */
const UNKNOWN_TOOL_RE = /unsupported native rust chat tool:\s*(\S+)/;

/** Evidence per signal. Enough to judge it, not enough to drown in. */
const MAX_EVIDENCE = 3;

/** How long a quote may be before it is cut. */
const MAX_QUOTE = 220;

/**
 * A tool has to fail at least this many times before it is a cluster.
 * One failure is an accident; a handful is a pattern.
 */
export const MIN_CLUSTER_FAILURES = 2;

/**
 * The share of a session's assistant turns that may be tool calls
 * without prose before the session counts as "no progress".
 */
export const NO_PROGRESS_TOOL_ONLY_SHARE = 0.8;

/**
 * ...and how many tool calls such a session must have made, so that a
 * short session does not qualify on a share alone.
 */
export const NO_PROGRESS_MIN_TOOL_CALLS = 20;

/**
 * Correction markers, matched on word boundaries.
 *
 * Word boundaries matter more than the list does: a substring match on
 * "nie działa" also fires inside "aktywnie dzialam", and a substring
 * match on "znow" also fires inside any longer word that contains it.
 */
const CORRECTION_MARKERS: RegExp[] = [
  /\bnie rozumiem\b/i,
  /\bniezrozumia[łl]\w*/i,
  /\bnietrzeba\b/i,
  /\bco wisi\b/i,
  /\bznow(?:u)?\b/i,
  /\bd[zż]waj\b/i,
  /\bwyjeba\w*/i,
  /\bnie (?:dzia[łl]a|robi|ma)\b/i,
];

/** A user turn that ends in a question mark is a question, not a complaint. */
function looksLikeQuestion(text: string): boolean {
  return text.trim().endsWith('?');
}

function quote(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_QUOTE ? `${clean.slice(0, MAX_QUOTE - 1)}…` : clean;
}

function spanDays(times: number[]): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  const days = (sorted[sorted.length - 1] - sorted[0]) / 86_400_000;
  return days < 1 ? 0 : Math.round(days);
}

/**
 * Normalize the arguments of a call so that "the same call" means the
 * same thing and not the same bytes.
 */
export function normalizeArgs(args: unknown): string {
  let raw: string;
  try {
    raw = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  } catch {
    return '<unserialisable>';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const normalize = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
      if (Array.isArray(value)) return value.map(normalize);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(value as Record<string, unknown>).sort()) {
          out[key] = normalize((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    };
    return JSON.stringify(normalize(parsed));
  } catch {
    return raw.replace(/\s+/g, ' ').trim();
  }
}

/**
 * S1 — tools that keep failing.
 *
 * One signal per tool. The severity follows the failure RATE, because
 * the rate is what separates a tool that is broken (100%) from a tool
 * that is merely used a lot (3.5% over 7 370 calls).
 */
export function detectToolFailureClusters(turns: DreamingTurn[]): DreamingSignal[] {
  interface ToolStats {
    calls: number;
    failures: number;
    sessions: Set<string>;
    times: number[];
    evidence: DreamingSignalEvidence[];
    unknownTool: boolean;
  }

  const stats = new Map<string, ToolStats>();
  for (const turn of turns) {
    for (const call of turn.calls ?? []) {
      const entry = stats.get(call.name) ?? {
        calls: 0,
        failures: 0,
        sessions: new Set<string>(),
        times: [],
        evidence: [],
        unknownTool: false,
      };
      entry.calls += 1;
      if (call.outcome?.ok === false) {
        entry.failures += 1;
        entry.sessions.add(turn.sessionId);
        const at = Date.parse(turn.at);
        if (!Number.isNaN(at)) entry.times.push(at);
        if (UNKNOWN_TOOL_RE.test(call.outcome?.error ?? '')) entry.unknownTool = true;
        if (entry.evidence.length < MAX_EVIDENCE) {
          entry.evidence.push({
            sessionId: turn.sessionId,
            sequence: turn.sequence,
            quote: quote(call.outcome?.error ?? call.name),
            toolName: call.name,
          });
        }
      }
      stats.set(call.name, entry);
    }
  }

  const signals: DreamingSignal[] = [];
  for (const [name, entry] of stats) {
    // A tool the runtime does not know is a different class of problem
    // from a tool that fails: its failure rate is 100 % by definition,
    // so even ONE such call is a wasted call and must be reported. The
    // cluster threshold exists to keep ordinary accidents quiet.
    if (entry.failures < MIN_CLUSTER_FAILURES && !entry.unknownTool) continue;
    const rate = entry.failures / entry.calls;
    const severity: DreamingSeverity = rate >= 0.5 ? 'high' : rate >= 0.1 ? 'medium' : 'low';
    const summary = entry.unknownTool
      ? `The tool "${name}" does not exist — the runtime answered ${entry.failures} of ${entry.calls} calls with "unsupported native rust chat tool".`
      : `"${name}" failed ${entry.failures} of ${entry.calls} calls (${(rate * 100).toFixed(1)} %) across ${entry.sessions.size} session(s).`;
    signals.push({
      id: `tool-failure-cluster:${name}`,
      kind: 'tool-failure-cluster',
      severity,
      summary,
      evidence: entry.evidence,
      prevalence: {
        occurrences: entry.failures,
        sessions: entry.sessions.size,
        spanDays: spanDays(entry.times),
        denominator: entry.calls,
      },
    });
  }
  return signals.sort((a, b) => b.prevalence.occurrences - a.prevalence.occurrences);
}

/**
 * S2 — the same call, failing again and again.
 *
 * The key is the tool plus its NORMALIZED arguments, so that the same
 * command with different whitespace or key order is one pattern, not
 * many.
 */
export function detectRepeatLoops(turns: DreamingTurn[]): DreamingSignal[] {
  interface Group {
    occurrences: number;
    failures: number;
    sessions: Set<string>;
    times: number[];
    evidence: DreamingSignalEvidence[];
    arguments: string;
  }

  const groups = new Map<string, Group>();
  for (const turn of turns) {
    for (const call of turn.calls ?? []) {
      const key = `${call.name}|${normalizeArgs(call.args)}`;
      const entry = groups.get(key) ?? {
        occurrences: 0,
        failures: 0,
        sessions: new Set<string>(),
        times: [],
        evidence: [],
        arguments: normalizeArgs(call.args),
      };
      entry.occurrences += 1;
      if (call.outcome?.ok === false) {
        entry.failures += 1;
        entry.sessions.add(turn.sessionId);
        const at = Date.parse(turn.at);
        if (!Number.isNaN(at)) entry.times.push(at);
        if (entry.evidence.length < MAX_EVIDENCE) {
          entry.evidence.push({
            sessionId: turn.sessionId,
            sequence: turn.sequence,
            quote: quote(call.outcome?.error ?? call.name),
            toolName: call.name,
          });
        }
      }
      groups.set(key, entry);
    }
  }

  const signals: DreamingSignal[] = [];
  for (const [key, entry] of groups) {
    if (entry.failures < 2) continue;
    const severity: DreamingSeverity =
      entry.failures >= 5 ? 'high' : entry.failures >= 3 ? 'medium' : 'low';
    signals.push({
      id: `repeat-loop:${key}`,
      kind: 'repeat-loop',
      severity,
      summary: `The same "${key.split('|')[0]}" call failed ${entry.failures} times across ${entry.sessions.size} session(s) (${entry.occurrences} identical calls in total).`,
      evidence: entry.evidence,
      prevalence: {
        occurrences: entry.failures,
        sessions: entry.sessions.size,
        spanDays: spanDays(entry.times),
        denominator: entry.occurrences,
      },
    });
  }
  return signals.sort((a, b) => b.prevalence.occurrences - a.prevalence.occurrences);
}

/**
 * S3 — the operator saying it went wrong.
 *
 * Measured to be sparse and imprecise, so this reports LOW severity and
 * names the limit in the summary. It exists to be counted, not to be
 * trusted on its own.
 */
export function detectCorrections(turns: DreamingTurn[]): DreamingSignal[] {
  const userTurns = turns.filter((turn) => turn.role === 'user');
  const evidence: DreamingSignalEvidence[] = [];
  const sessions = new Set<string>();
  const times: number[] = [];

  for (const turn of userTurns) {
    const text = turn.text ?? '';
    if (looksLikeQuestion(text)) continue;
    if (!CORRECTION_MARKERS.some((marker) => marker.test(text))) continue;
    sessions.add(turn.sessionId);
    const at = Date.parse(turn.at);
    if (!Number.isNaN(at)) times.push(at);
    if (evidence.length < MAX_EVIDENCE) {
      evidence.push({ sessionId: turn.sessionId, sequence: turn.sequence, quote: quote(text) });
    }
  }

  const occurrences = userTurns.filter((turn) => {
    const text = turn.text ?? '';
    if (looksLikeQuestion(text)) return false;
    return CORRECTION_MARKERS.some((marker) => marker.test(text));
  }).length;

  if (occurrences === 0) return [];

  return [
    {
      id: 'correction:operator-dissatisfaction',
      kind: 'correction',
      severity: 'low',
      summary: `${occurrences} of ${userTurns.length} user turns match a correction marker. Keyword detection is too sparse and too imprecise to carry a memory decision on its own — this signal belongs to the LLM tier (D5).`,
      evidence,
      prevalence: {
        occurrences,
        sessions: sessions.size,
        spanDays: spanDays(times),
        denominator: userTurns.length,
      },
    },
  ];
}

/**
 * S4 — the agent working without concluding.
 *
 * The design's wording is "tool calls vastly outnumber assistant
 * answers". Measured on the live corpus, that ratio NEVER exceeds 1.8
 * and no session ends on a tool result — so the literal form of the
 * detector would find nothing, ever, and a detector that always finds
 * nothing is indistinguishable from a broken one.
 *
 * So this measures the shape that actually occurs: assistant turns that
 * call tools and carry no prose. A session whose assistant turns are
 * almost entirely tool calls, with enough calls to be a real stretch of
 * work, is reported — and the summary says plainly what was measured,
 * because in this operator's line of work a long tool-heavy session is
 * also a NORMAL session, and only a human can say which one it was.
 */
export function detectNoProgress(turns: DreamingTurn[]): DreamingSignal[] {
  interface SessionStats {
    assistantTurns: number;
    toolOnlyTurns: number;
    toolCalls: number;
    times: number[];
    evidence: DreamingSignalEvidence[];
  }

  const sessions = new Map<string, SessionStats>();
  for (const turn of turns) {
    const entry = sessions.get(turn.sessionId) ?? {
      assistantTurns: 0,
      toolOnlyTurns: 0,
      toolCalls: 0,
      times: [],
      evidence: [],
    };
    const at = Date.parse(turn.at);
    if (!Number.isNaN(at)) entry.times.push(at);
    if (turn.role === 'assistant') {
      entry.assistantTurns += 1;
      const hasCalls = (turn.calls?.length ?? 0) > 0;
      const hasProse = (turn.text ?? '').trim().length > 0;
      if (hasCalls && !hasProse) {
        entry.toolOnlyTurns += 1;
        if (entry.evidence.length < MAX_EVIDENCE) {
          entry.evidence.push({
            sessionId: turn.sessionId,
            sequence: turn.sequence,
            quote: quote(
              `tool call without prose: ${(turn.calls ?? []).map((c) => c.name).join(', ')}`,
            ),
          });
        }
      }
    }
    if (turn.role === 'tool') entry.toolCalls += 1;
    sessions.set(turn.sessionId, entry);
  }

  const signals: DreamingSignal[] = [];
  for (const [sessionId, entry] of sessions) {
    if (entry.assistantTurns === 0) continue;
    const share = entry.toolOnlyTurns / entry.assistantTurns;
    if (share < NO_PROGRESS_TOOL_ONLY_SHARE) continue;
    if (entry.toolCalls < NO_PROGRESS_MIN_TOOL_CALLS) continue;
    const severity: DreamingSeverity =
      entry.toolCalls >= 200 ? 'high' : entry.toolCalls >= 50 ? 'medium' : 'low';
    signals.push({
      id: `no-progress:${sessionId}`,
      kind: 'no-progress',
      severity,
      summary: `${entry.toolOnlyTurns} of ${entry.assistantTurns} assistant turns in this session called tools and said nothing (${entry.toolCalls} tool calls). The session's assistant turns are work without narration — whether that is drift or just how the work looks is a human call.`,
      evidence: entry.evidence,
      prevalence: {
        occurrences: entry.toolOnlyTurns,
        sessions: 1,
        spanDays: spanDays(entry.times),
        denominator: entry.assistantTurns,
      },
    });
  }
  return signals.sort((a, b) => b.prevalence.occurrences - a.prevalence.occurrences);
}

/**
 * Run every deterministic detector over a corpus.
 */
export function detectSignals(turns: DreamingTurn[]): DreamingSignal[] {
  return [
    ...detectToolFailureClusters(turns),
    ...detectRepeatLoops(turns),
    ...detectCorrections(turns),
    ...detectNoProgress(turns),
  ];
}
