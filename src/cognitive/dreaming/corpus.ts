/**
 * The dreaming corpus — what the out-of-band review is allowed to see.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reflection loop (`src/infra/runtime/reflection-loop.ts`) reads chain
 * blocks only: journal, decisions, reflections, cases. It never reads the
 * conversations. Measured on this host (2026-11-02): 17 071 messages
 * across 45 sessions sit in `operator_chat_messages`, completely outside
 * the loop that is supposed to learn from experience — including 8 402
 * tool calls with their full arguments and their outcomes.
 *
 * This module builds that missing view. It is deliberately PURE: it takes
 * rows and returns turns. The database access lives in the repository,
 * and every rule below is testable without a database.
 *
 * THREE THINGS THE MEASUREMENT TAUGHT
 * ------------------------------------
 * 1. The content is wrapped. Every user turn is `<user_input>…` and
 *    every tool result is `<tool_output tool="…">…`. A text detector
 *    that does not strip the wrapper is matching the wrapper, not the
 *    speech. Measured: 593/593 user turns and 8 437/8 437 tool results
 *    are wrapped; 0/8 102 assistant turns are.
 *
 * 2. The closing tag comes in TWO spellings. The normal one is
 *    `</tool_output>`. A minority of rows — measured: 9 — close with
 *    `<\/tool_output>`, because the tool's own output contained that
 *    literal sequence and the harness escaped it on the way in. A parser
 *    that matches only the plain spelling silently leaves those rows
 *    unparsed. Both spellings are handled here.
 *
 * 3. The body can contain the wrapper text itself. Stripping therefore
 *    takes the FIRST opening tag and the LAST closing tag, never a
 *    non-greedy match — a non-greedy match cuts at the first closing
 *    tag it finds, which is an inner one in exactly the rows where the
 *    body quotes the wrapper.
 *
 * THE JOIN
 * ---------
 * A tool call's name and arguments live on the ASSISTANT row
 * (`tool_calls_json`); its outcome lives on the TOOL row. The two are
 * linked by `tool_call_id`. Measured: 8 402 call ids, 8 402 tool rows,
 * a 1:1 join with no orphans.
 */

import {
  classifyToolResult,
  type FailureClassification,
} from '../../core/failure-classification.js';

export type DreamingRole = 'user' | 'assistant' | 'tool';

export interface DreamingCall {
  /** The provider's call id — the join key to the tool result. */
  id: string;
  /** The tool the agent asked for. */
  name: string;
  /** The arguments the agent passed. */
  args: unknown;
  /**
   * The outcome of this call, joined from the tool row.
   *
   * Attached to the CALL, not only to the tool turn: "what did the agent
   * ask for and how did it go" is one fact, and splitting it across two
   * rows makes every consumer re-join it.
   */
  outcome?: DreamingOutcome;
}

export interface DreamingOutcome {
  /**
   * The four-state answer, from the one shared classifier
   * (`src/core/failure-classification.ts`).
   *
   * `inconclusive` is the state that did not exist before: the process
   * exited non-zero and said nothing about why. It is neither a success
   * nor a failure, and the corpus used to count it as a failure — 133
   * results that are fine.
   */
  classification: FailureClassification;
  /**
   * True = success, false = failure, null = neither.
   *
   * `null` covers both `inconclusive` and `unknown`; `classification` is
   * what tells them apart.
   */
  ok: boolean | null;
  /** The failure reason, when the envelope carries one. */
  error?: string;
  /** A one-line reason: the envelope's error, else the process's own diagnostic, else the exit code. */
  reason?: string;
  /** The process exit code, for tools that run commands. */
  exitCode?: number;
  /** The parsed envelope, when it parsed. */
  payload?: Record<string, unknown>;
}

export interface DreamingTurn {
  sessionId: string;
  sequence: number;
  at: string;
  role: DreamingRole;
  /** The speech, with the wrapper removed. */
  text: string;
  /** The tool that produced this turn (tool rows only). */
  toolName?: string;
  /** The provider's call id (tool rows only). */
  toolCallId?: string;
  provider?: string;
  model?: string;
  /** The calls this assistant turn made, with their outcomes attached. */
  calls?: DreamingCall[];
  /** The outcome of a tool turn. */
  outcome?: DreamingOutcome;
}

/** A raw row, as the database gives it to us. */
export interface CorpusRow {
  session_id: string;
  sequence: number;
  role: string;
  content: string;
  tool_call_id?: string | null;
  tool_name?: string | null;
  tool_calls_json?: string | null;
  provider?: string | null;
  model?: string | null;
  created_at: string;
}

/** The opening tag of a user turn. */
const USER_OPEN = '<user_input>';
/** The opening tag of a tool result, with the tool name in an attribute. */
const TOOL_OPEN_RE = /^<tool_output\b[^>]*>/;

/**
 * Remove the envelope from a message.
 *
 * Returns the speech and, for a tool result, the tool name the
 * envelope declared. A message without an envelope is returned as-is:
 * the assistant turns have no wrapper, and a wrapped message with an
 * unrecognised tag is better read whole than cut wrong.
 */
export function stripEnvelope(content: string): {
  text: string;
  toolName?: string;
  wrapped: boolean;
} {
  const raw = content ?? '';

  if (raw.startsWith(USER_OPEN)) {
    const body = stripAfterOpenTag(raw, 'user_input');
    if (body !== null) return { text: body, wrapped: true };
  }

  const toolOpen = TOOL_OPEN_RE.exec(raw);
  if (toolOpen) {
    const body = stripAfterOpenTag(raw, 'tool_output');
    if (body !== null) {
      const nameMatch = /<tool_output\b[^>]*\btool="([^"]*)"/.exec(raw);
      return {
        text: body,
        toolName: nameMatch?.[1] || undefined,
        wrapped: true,
      };
    }
  }

  return { text: raw, wrapped: false };
}

/**
 * The body between the opening tag and the LAST closing tag.
 *
 * The last one, not the first: a body may quote the wrapper, and a
 * non-greedy match would cut the message at that inner quote.
 */
function stripAfterOpenTag(raw: string, tag: 'user_input' | 'tool_output'): string | null {
  const openIndex =
    tag === 'user_input' ? raw.indexOf(USER_OPEN) : raw.search(/<tool_output\b[^>]*>/);
  if (openIndex < 0) return null;

  const afterOpen = raw.slice(openIndex);
  const openMatch = /^(<user_input>|<tool_output\b[^>]*>)/.exec(afterOpen);
  if (!openMatch) return null;
  const bodyStart = openMatch[0].length;

  // Find the LAST closing tag of this kind.
  const closePattern = new RegExp(`<\\\\?/${tag}>`, 'g');
  let lastIndex = -1;
  let match: RegExpExecArray | null;
  while ((match = closePattern.exec(afterOpen)) !== null) {
    lastIndex = match.index;
  }
  if (lastIndex < 0) return null;

  return afterOpen.slice(bodyStart, lastIndex).trim();
}

/**
 * Decide, structurally, whether a tool result is a failure.
 *
 * WHY THIS IS NOT A SECOND OPINION
 * --------------------------------
 * This used to be a copy of the runtime's classifier with one extra rule
 * (`exitCode != 0`). Two copies of the same question is what the design
 * warned against, and the copy here was the stricter one — which meant the
 * runtime's telemetry saw 167 failures where the corpus saw 434, and the
 * difference was 267 real failures nobody was counting.
 *
 * It is now a thin adapter over the one shared classifier
 * (`src/core/failure-classification.ts`), so the corpus and the runtime
 * cannot drift apart again.
 *
 * WHAT THE RULE COUNTS
 * ---------------------
 * A non-zero exit code alone is NOT a failure: `grep` returns 1 when it
 * finds nothing, `diff` returns 1 when the files match, `ls` returns 2 for
 * a path that does not exist. Measured over the live corpus, the naive rule
 * scores 5.14 % and would flip the tool-error SLO on the strength of
 * results that are fine.
 *
 * So the answer is four-valued — `failure`, `inconclusive`, `success`,
 * `unknown` — and the corpus keeps the two apart. `inconclusive` is a
 * non-zero exit with nothing on stderr and a code that CAN mean "nothing
 * matched"; it is not a success and not a failure, and the old two-valued
 * rule had nowhere to put it.
 */
export function classifyOutcome(text: string): DreamingOutcome {
  const verdict = classifyToolResult(text);
  return {
    classification: verdict.classification,
    ok:
      verdict.classification === 'success'
        ? true
        : verdict.classification === 'failure'
          ? false
          : null,
    error: verdict.error,
    reason: verdict.reason,
    exitCode: verdict.exitCode,
    payload: verdict.payload,
  };
}

/** The calls an assistant turn made. */
export function parseCalls(toolCallsJson: string | null | undefined): DreamingCall[] {
  if (!toolCallsJson || toolCallsJson.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const calls: DreamingCall[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.name !== 'string') continue;
    calls.push({ id: record.id, name: record.name, args: record.arguments });
  }
  return calls;
}

/**
 * Build the corpus from raw rows.
 *
 * The join: a tool row carries the outcome and the call id; the
 * assistant row that made the call carries the name and the arguments.
 * The outcome is attached to the call it belongs to, and the tool turn
 * also keeps its own outcome so a result can be scored on its own.
 */
export function buildCorpus(rows: CorpusRow[]): DreamingTurn[] {
  // Identifiers are scoped to a session. Within a session, duplicated call
  // IDs are ambiguous and must never silently acquire another call's result.
  const keyFor = (session: string, callId: string) => JSON.stringify([session, callId]);
  const outcomesByKey = new Map<string, Array<{ sequence: number; outcome: DreamingOutcome }>>();
  const assistantCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.role === 'assistant') {
      for (const call of parseCalls(row.tool_calls_json)) {
        const key = keyFor(row.session_id, call.id);
        assistantCounts.set(key, (assistantCounts.get(key) ?? 0) + 1);
      }
    } else if (row.role === 'tool' && row.tool_call_id) {
      const key = keyFor(row.session_id, row.tool_call_id);
      const { text } = stripEnvelope(row.content);
      const outcomes = outcomesByKey.get(key) ?? [];
      outcomes.push({ sequence: row.sequence, outcome: classifyOutcome(text) });
      outcomesByKey.set(key, outcomes);
    }
  }

  const turns: DreamingTurn[] = [];
  for (const row of rows) {
    const role = normalizeRole(row.role);
    if (!role) continue;
    const { text, toolName } = stripEnvelope(row.content);

    if (role === 'tool') {
      turns.push({
        sessionId: row.session_id,
        sequence: row.sequence,
        at: row.created_at,
        role: 'tool',
        text,
        toolName: toolName ?? row.tool_name ?? undefined,
        toolCallId: row.tool_call_id ?? undefined,
        provider: row.provider ?? undefined,
        model: row.model ?? undefined,
        outcome: classifyOutcome(text),
      });
      continue;
    }

    if (role === 'assistant') {
      const calls = parseCalls(row.tool_calls_json);
      const withOutcomes = calls.map((call) => {
        const key = keyFor(row.session_id, call.id);
        const outcomes = outcomesByKey.get(key);
        const unique = assistantCounts.get(key) === 1 && outcomes?.length === 1;
        const match = unique ? outcomes?.[0] : undefined;
        return match && match.sequence > row.sequence ? { ...call, outcome: match.outcome } : call;
      });
      turns.push({
        sessionId: row.session_id,
        sequence: row.sequence,
        at: row.created_at,
        role: 'assistant',
        text,
        provider: row.provider ?? undefined,
        model: row.model ?? undefined,
        calls: withOutcomes.length > 0 ? withOutcomes : undefined,
      });
      continue;
    }
    turns.push({
      sessionId: row.session_id,
      sequence: row.sequence,
      at: row.created_at,
      role: 'user',
      text,
    });
  }
  return turns;
}

function normalizeRole(role: string): DreamingRole | null {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role;
  return null;
}

/**
 * The statistics the corpus builder can report about itself.
 *
 * They exist so a caller can tell "the corpus is empty" from "the corpus
 * was built and it contains nothing interesting" — the difference the
 * SLO report learned to make about telemetry, applied here to memory.
 */
export interface CorpusStats {
  turns: number;
  sessions: number;
  userTurns: number;
  assistantTurns: number;
  toolTurns: number;
  calls: number;
  callsWithOutcome: number;
  /** Tool results the shared classifier calls a failure. */
  failures: number;
  /**
   * Tool results that exited non-zero and said nothing about why: the
   * shell's "no match". Not a failure, not a success — the state the
   * two-valued rule had nowhere to put.
   */
  inconclusiveOutcomes: number;
  /** Tool results whose envelope did not parse at all. */
  unknownOutcomes: number;
  wrapped: number;
  /** Rows whose envelope did not parse as JSON. */
  unparsed: number;
}

export function corpusStats(turns: DreamingTurn[], rows: CorpusRow[]): CorpusStats {
  const sessions = new Set<string>();
  let userTurns = 0;
  let assistantTurns = 0;
  let toolTurns = 0;
  let calls = 0;
  let callsWithOutcome = 0;
  let failures = 0;
  let inconclusiveOutcomes = 0;
  let unknownOutcomes = 0;
  let wrapped = 0;
  let unparsed = 0;

  for (const turn of turns) {
    sessions.add(turn.sessionId);
    if (turn.role === 'user') userTurns += 1;
    if (turn.role === 'assistant') assistantTurns += 1;
    if (turn.role === 'tool') {
      toolTurns += 1;
      if (turn.outcome?.classification === 'failure') failures += 1;
      if (turn.outcome?.classification === 'inconclusive') inconclusiveOutcomes += 1;
      if (!turn.outcome || turn.outcome.classification === 'unknown') unknownOutcomes += 1;
      if (turn.outcome?.payload === undefined && turn.text.trim().length > 0) unparsed += 1;
    }
    for (const call of turn.calls ?? []) {
      calls += 1;
      if (call.outcome) callsWithOutcome += 1;
    }
  }

  for (const row of rows) {
    if (stripEnvelope(row.content).wrapped) wrapped += 1;
  }

  return {
    turns: turns.length,
    sessions: sessions.size,
    userTurns,
    assistantTurns,
    toolTurns,
    calls,
    callsWithOutcome,
    failures,
    inconclusiveOutcomes,
    unknownOutcomes,
    wrapped,
    unparsed,
  };
}
