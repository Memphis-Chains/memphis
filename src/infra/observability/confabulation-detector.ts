/**
 * Confabulation event detector — Sprint 0.2.
 *
 * Defines a measurable definition of bot confabulation across three rules
 * and emits structured events to the same JSONL sink that Sprint 0.1
 * established. Subsequent sprints (1.3 anti-confab guard) consume these
 * events to validate that mitigations actually move the counter down over
 * a 7-day rolling window.
 *
 * Rules (v1):
 *   A. Tool returned semantic error (output.shape === 'error') OR threw,
 *      but the model's next assistant message claims success
 *      (PL + EN success phrases + checkmark glyphs).
 *   B. Model references a phantom config key — a `MEMPHIS_*` env var or
 *      `ALLOW_*=true` flag that does not exist in the runtime config
 *      schema. Hardcoded blocklist of known fabrications observed in
 *      Memphis Agent transcripts (2026-04-27 confab incident); future
 *      iterations may cross-reference `memphis_self_describe` output.
 *   C. Tool returned an empty list / zero count, but the model enumerates
 *      concrete items in its reply (numbered list, bullets, dashes).
 *
 * Output: ConfabulationEvent | null. Caller (agent-runtime) decides
 * whether to record the event via `recordConfabulationEvent`, which writes
 * to the local JSONL sink with name `confabulation.event` so cron-driven
 * `confabulation-watch` task (Sprint 0.2 follow-up) can grep deterministic
 * line shape.
 *
 * v1 is regex-based — deterministic, cheap, no recursive LLM-as-judge
 * surface. If false-positive rate exceeds 10% in the first week's
 * production data, v2 may add an LLM-as-judge tier (rule D) gated on
 * v1 detection so we don't pay model cost on every turn.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { recordLocalSpan } from './console-exporter.js';
import { classifyToolOutput } from './instrument.js';
import { getDataDir } from '../../config/paths.js';

export type ConfabulationRule = 'A' | 'B' | 'C' | 'D' | 'E';

export interface ConfabulationEvent {
  rule: ConfabulationRule;
  /** Short snippet of evidence (the matched phrase or phantom key). */
  evidence: string;
  /** Name of the tool whose output triggered the rule (A, C, D, E). */
  toolName?: string;
}

export interface ToolResultSnapshot {
  name: string;
  output: string;
}

// ── Rule A: error → success claim ───────────────────────────────────────────

/**
 * PL + EN success phrases. Boundary-anchored where word-shape matters,
 * loose otherwise (e.g. emoji checkmarks). Order matters only for which
 * snippet we surface as evidence — first match wins.
 */
// Polish letters (ą ć ę ł ń ó ś ź ż) are not part of \w in JS regex without
// the `u` flag + Unicode property escapes, which we don't want to bring in
// for a v1 deterministic matcher. Use Unicode-aware boundaries via
// negative lookbehind/lookahead with explicit letter classes for PL phrases;
// English phrases stay on classic \b boundaries (ASCII letters only).
const PL_LETTER = '[A-Za-zĄąĆćĘęŁłŃńÓóŚśŹźŻż]';
function pl(phrase: string): RegExp {
  // Match `phrase` only when not flanked by a Polish/ASCII letter on either
  // side. Matches whole-word semantics across PL diacritics.
  return new RegExp(`(?<!${PL_LETTER})${phrase}(?!${PL_LETTER})`, 'iu');
}

const SUCCESS_PHRASES: RegExp[] = [
  // Polish
  pl('udało się'),
  pl('zrobione'),
  pl('skonfigurowan[eya]'),
  pl('włączon[eya]'),
  pl('ustawion[eya]'),
  pl('wykonane'),
  pl('zapisane'),
  pl('wczytane'),
  pl('naprawione'),
  pl('gotowe'),
  pl('działa'),
  // English
  /\bdone\b/i,
  /\benabled\b/i,
  /\bset up\b/i,
  /\bconfigured\b/i,
  /\bsuccessful(?:ly)?\b/i,
  /\bworking\b/i,
  /\bready\b/i,
  /\bfixed\b/i,
  /\bloaded\b/i,
  /\bsaved\b/i,
  /\ball good\b/i,
  /\bok ✅/i,
  /✅\s*(?:ok|done|all good|gotowe|zrobione)/i,
  // Bare checkmark in a "this worked" context — restricted to status-line shapes
  // to limit false positives (the bot uses ✅ in tables that aren't claims).
  /^\s*✅/m,
];

function claimContainsSuccess(modelClaim: string): RegExpMatchArray | null {
  for (const re of SUCCESS_PHRASES) {
    const match = modelClaim.match(re);
    if (match) return match;
  }
  return null;
}

function toolOutputIsError(output: string): boolean {
  return classifyToolOutput(output) === 'error';
}

// ── Rule B: phantom config keys ─────────────────────────────────────────────

/**
 * Hardcoded blocklist of fabricated runtime keys observed in real
 * Memphis Agent transcripts. New entries appended as future incidents
 * surface them — keeps detector deterministic without runtime config
 * cross-reference.
 *
 * Pattern: literal env-var-shape strings the model has invented.
 */
const PHANTOM_CONFIG_KEYS: RegExp[] = [
  // From 2026-04-27 incident — bot suggested ALLOW_EXEC=true to "unblock" exec
  /\bALLOW_EXEC\s*=\s*true\b/i,
  /\bALLOW_GIT\s*=\s*true\b/i,
  /\bALLOW_CODE_READ\s*=\s*true\b/i,
  // Generic "I'd unblock with X" pattern that's almost always fabricated
  /\bMEMPHIS_(?:ALLOW|UNLOCK|BYPASS)_[A-Z_]+\s*=\s*true\b/i,
  // Fabricated "permission flag" the runtime never exposes
  /\bENABLE_TIER_[0-9]_BYPASS\b/i,
];

function findPhantomConfigKey(modelClaim: string): string | null {
  for (const re of PHANTOM_CONFIG_KEYS) {
    const match = modelClaim.match(re);
    if (match) return match[0];
  }
  return null;
}

// ── Rule C: empty result → enumeration ──────────────────────────────────────

/**
 * Tool output represents an empty list (no items returned). Covers the
 * common shapes Memphis tools use:
 *   - bare `[]`
 *   - `{ "items": [] }` / `{ "results": [] }` / `{ "matches": [] }` etc.
 *   - `{ "count": 0 }` / `{ "total": 0 }`
 */
function toolOutputIsEmptyList(output: string): boolean {
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed.length === 0;
    if (parsed === null || typeof parsed !== 'object') return false;
    const obj = parsed as Record<string, unknown>;
    for (const key of ['items', 'results', 'matches', 'entries', 'records', 'data']) {
      const value = obj[key];
      if (Array.isArray(value)) return value.length === 0;
    }
    if (typeof obj.count === 'number' && obj.count === 0) return true;
    if (typeof obj.total === 'number' && obj.total === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Model reply enumerates concrete items — numbered, bulleted, or dashed
 * list with at least 2 entries on consecutive lines.
 */
const ENUMERATION_PATTERN = /(?:^|\n)\s*(?:[-•*]|\d+\.)\s+\S/g;

function claimEnumeratesItems(modelClaim: string): boolean {
  const matches = modelClaim.match(ENUMERATION_PATTERN);
  return matches !== null && matches.length >= 2;
}

// ── Rule D: tool returned non-empty data, reply quotes none of it ───────────

/**
 * Extract verifiable strings from a parsed tool result that the model could
 * reasonably echo. We look at fields where the value is recognisably from
 * the tool, not a generic word. Title/url/name/path/id strings are the
 * strongest signals; numeric counts are weaker (the model could guess "3"
 * accidentally) but still useful when the count is non-trivial.
 *
 * Returns up to ~50 candidate strings, deduped, length-filtered (≥4 chars
 * for strings, anything for numbers cast to string). Length floor avoids
 * false positives where the model uses a 1-2 char field value coincidentally.
 */
function extractVerifiableQuotes(parsed: unknown): string[] {
  const quotes = new Set<string>();
  const STRING_FIELDS = new Set([
    'title',
    'name',
    'url',
    'description',
    'path',
    'id',
    'query',
    'model',
    'provider',
    'surface',
    'tool',
    'kind',
    'category',
    'host',
    'agent',
    'did',
  ]);
  const MAX_QUOTES = 50;
  const MIN_STRING_LEN = 4;

  function walk(node: unknown, depth = 0): void {
    if (quotes.size >= MAX_QUOTES || depth > 6) return;
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node.slice(0, 20)) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (STRING_FIELDS.has(k.toLowerCase()) && typeof v === 'string' && v.length >= MIN_STRING_LEN) {
          quotes.add(v);
        }
        if (k === 'count' && typeof v === 'number' && v > 0) {
          quotes.add(String(v));
        }
        walk(v, depth + 1);
      }
    }
  }

  walk(parsed);
  return [...quotes];
}

function toolOutputHasData(output: string): { hasData: boolean; parsed?: unknown } {
  try {
    const parsed: unknown = JSON.parse(output);
    if (Array.isArray(parsed)) return { hasData: parsed.length > 0, parsed };
    if (parsed === null || typeof parsed !== 'object') return { hasData: false };
    const obj = parsed as Record<string, unknown>;
    // Reuse the shapes Rule C looks at, inverted.
    for (const key of ['items', 'results', 'matches', 'entries', 'records', 'data', 'tools']) {
      const value = obj[key];
      if (Array.isArray(value)) return { hasData: value.length > 0, parsed };
    }
    if (typeof obj.count === 'number' && obj.count > 0) return { hasData: true, parsed };
    if (typeof obj.total === 'number' && obj.total > 0) return { hasData: true, parsed };
    // Generic shape: any tool result with at least 3 keys probably has
    // substantive data. Excludes pure error-shape `{error: "..."}` (1 key)
    // and empty-result-shape `{count: 0}` (1 key).
    return { hasData: Object.keys(obj).length >= 3, parsed };
  } catch {
    return { hasData: false };
  }
}

/**
 * Decompose a candidate into "distinctive tokens" — punctuation-split,
 * length≥5, dedup, lower-cased. Lets us catch partial matches: title
 * "Memphis-Chains/memphis: Sovereign AI runtime" produces tokens
 * `['memphis-chains', 'memphis', 'sovereign', 'runtime']` so a reply
 * mentioning just "Memphis-Chains/memphis" still anchors.
 */
function distinctiveTokens(candidate: string): string[] {
  const tokens = candidate
    .toLowerCase()
    .split(/[\s/:.,()\\[\]{}<>|;'"!?@#$%^&*+=]+/)
    .filter((t) => t.length >= 5);
  return [...new Set(tokens)];
}

function replyQuotesAnyOf(modelClaim: string, candidates: string[]): boolean {
  if (candidates.length === 0) return true; // nothing to quote — don't fire
  const lower = modelClaim.toLowerCase();
  for (const c of candidates) {
    // Strings need ≥4 chars (avoid 'is', 'the', 'and' false matches).
    // Pure-digit candidates are accepted at ≥2 chars — counts like '41'
    // or '2920' are specific enough to anchor a quote.
    const isDigits = /^\d+$/.test(c);
    if (isDigits) {
      if (c.length >= 2 && lower.includes(c)) return true;
      continue;
    }
    if (c.length < 4) continue;
    // Whole-candidate substring (catches short titles, urls, names).
    if (lower.includes(c.toLowerCase())) return true;
    // Distinctive-token fallback — the reply may quote part of a longer
    // candidate (typical for titles, urls). Avoids forcing the model to
    // echo the entire field verbatim.
    for (const token of distinctiveTokens(c)) {
      if (lower.includes(token)) return true;
    }
  }
  return false;
}

// ── Rule E: tool invocation printed as code instead of called ──────────────

/**
 * Detect the failure mode caught in 2026-05-06 01:14-01:28 Telegram
 * session: bot at tier 3 wrote bash code blocks containing
 * `memphis_<name>(...)` style calls instead of actually invoking the
 * tool. The text-reply has the SHAPE of a tool call but no tool_call
 * went through to the runtime. From the operator's side it looks like
 * the bot is doing nothing — just narrating commands forever.
 *
 * Pattern: code-fence block (```bash, ```sh, or untyped ```) containing
 * a `memphis_<name>` token. If the model's tool-call list for the turn
 * is empty AND the reply shows this pattern, fire Rule E.
 *
 * False-positive guard: explicitly-prefixed examples like "you would
 * run: \`memphis_xxx\`" are fine — we look for code-fence blocks
 * specifically, not inline backticks. And if the bot DID invoke the
 * tool this turn (toolResults non-empty for the same name), it's
 * likely a follow-up explanation, not a confab.
 */
const TOOL_FENCE_PATTERN = /```(?:bash|sh|shell)?\s*\n?[^`]*\bmemphis_([a-z_]+)\b[^`]*```/i;

function findToolFencedAsCode(modelClaim: string): { matched: string; toolName: string } | null {
  const match = modelClaim.match(TOOL_FENCE_PATTERN);
  if (!match) return null;
  return { matched: match[0].slice(0, 200), toolName: `memphis_${match[1]}` };
}

// ── Main entry ──────────────────────────────────────────────────────────────

export function detectConfabulation(
  toolResults: ToolResultSnapshot[],
  modelClaim: string,
): ConfabulationEvent | null {
  if (!modelClaim || modelClaim.length === 0) return null;

  // Rule A — error tool → success claim
  for (const tr of toolResults) {
    if (toolOutputIsError(tr.output)) {
      const successMatch = claimContainsSuccess(modelClaim);
      if (successMatch) {
        return {
          rule: 'A',
          evidence: successMatch[0],
          toolName: tr.name,
        };
      }
    }
  }

  // Rule B — phantom config key
  const phantom = findPhantomConfigKey(modelClaim);
  if (phantom !== null) {
    return { rule: 'B', evidence: phantom };
  }

  // Rule C — empty result enumerated
  for (const tr of toolResults) {
    if (toolOutputIsEmptyList(tr.output) && claimEnumeratesItems(modelClaim)) {
      return {
        rule: 'C',
        evidence: 'enumeration after empty tool output',
        toolName: tr.name,
      };
    }
  }

  // Rule D — tool returned non-empty data, reply quotes none of it. The
  // 2026-05-05 Telegram session caught the bot calling memphis_self_describe
  // (4500B JSON), memphis_brave_search (5000B results), then replying
  // "Whisper offline / google zwróciło Chainlink" — neither claim references
  // any field from the tool output. Rules A/B/C all pass; reply still lies.
  for (const tr of toolResults) {
    if (toolOutputIsError(tr.output)) continue;
    const { hasData, parsed } = toolOutputHasData(tr.output);
    if (!hasData || parsed === undefined) continue;
    const quotes = extractVerifiableQuotes(parsed);
    if (quotes.length === 0) continue;
    if (!replyQuotesAnyOf(modelClaim, quotes)) {
      return {
        rule: 'D',
        evidence: `tool returned ${quotes.length} quotable field(s); reply quotes none`,
        toolName: tr.name,
      };
    }
  }

  // Rule E — tool invocation printed as code instead of called. Only
  // fires when the reply shows a memphis_* call inside a code-fence
  // block AND the model didn't actually invoke that tool this turn.
  // Suppress when the model both invoked AND showed the call as a
  // follow-up explanation.
  const fenced = findToolFencedAsCode(modelClaim);
  if (fenced) {
    const calledThisTurn = toolResults.some((tr) => tr.name === fenced.toolName);
    if (!calledThisTurn) {
      return {
        rule: 'E',
        evidence: `code-fence call to ${fenced.toolName} with no tool_call this turn`,
        toolName: fenced.toolName,
      };
    }
  }

  return null;
}

// ── Recording ───────────────────────────────────────────────────────────────

/**
 * Record a detected confabulation event to the local JSONL sink. Uses
 * `recordLocalSpan` so the event lands alongside other observability
 * spans, keyed by the stable name `confabulation.event`. Cron-driven
 * watch tasks can grep deterministically.
 *
 * `surface` (optional) lets the caller stamp which channel produced the
 * confabulation (telegram | http | cli | mcp | …) so the operator can
 * see "telegram is the noisy one" without having to correlate against
 * sibling spans. Defaults to 'unknown' when the caller is a generic
 * agent loop with no channel context.
 */
export function recordConfabulationEvent(
  event: ConfabulationEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
  surface: string = 'unknown',
): void {
  recordLocalSpan(
    {
      name: 'confabulation.event',
      attrs: {
        'confabulation.rule': event.rule,
        'confabulation.tool': event.toolName ?? 'none',
        'confabulation.surface': surface,
        'confabulation.evidence_length': event.evidence.length,
        // Truncate evidence for storage (full text would balloon JSONL on
        // long claims). 200 chars is enough for human triage in PULSE.md.
        'confabulation.evidence_snippet': event.evidence.slice(0, 200),
      },
      status: 'ok',
    },
    rawEnv,
  );
}

// ── 7-day rolling counter ───────────────────────────────────────────────────

/**
 * Scan local JSONL telemetry files for `confabulation.event` records
 * emitted within the last `windowMs` milliseconds (default 7 days) and
 * return the count.
 *
 * Used by `memphis_health.confabulationEvents7d` so operators (and the
 * cron-driven `confabulation-watch` task) see baseline / regression at
 * a glance without bespoke log-grepping.
 *
 * Failure modes: missing telemetry dir, unreadable files, malformed JSONL
 * lines — all swallowed and treated as "no events". Health endpoint must
 * never error because telemetry inspection failed.
 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const SPANS_FILE_PATTERN = /^spans-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function countConfabulationEventsInWindow(
  windowMs: number = SEVEN_DAYS_MS,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): number {
  const telemetryDir = path.join(getDataDir(rawEnv), 'telemetry');
  if (!existsSync(telemetryDir)) return 0;

  const cutoffMs = now.getTime() - windowMs;

  let files: string[];
  try {
    files = readdirSync(telemetryDir);
  } catch {
    return 0;
  }

  // Limit to JSONL files whose date stamp is within the window. We compare
  // the DAY of the file to the cutoff DAY so we don't open files that
  // can't possibly contain in-window records — keeps health calls cheap.
  const cutoffDay = new Date(cutoffMs);
  const cutoffStamp = `${cutoffDay.getUTCFullYear()}-${String(
    cutoffDay.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(cutoffDay.getUTCDate()).padStart(2, '0')}`;

  const candidates = files.filter((f) => {
    const match = f.match(SPANS_FILE_PATTERN);
    if (!match) return false;
    return match[1] >= cutoffStamp;
  });

  let count = 0;
  for (const f of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path.join(telemetryDir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      // Quick reject on the most common case (non-confab spans). Avoids
      // JSON.parse cost on every line — health is called frequently.
      if (!line.includes('"confabulation.event"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== 'object') continue;
      const obj = parsed as { name?: unknown; ts?: unknown };
      if (obj.name !== 'confabulation.event') continue;
      if (typeof obj.ts !== 'string') continue;
      const tsMs = Date.parse(obj.ts);
      if (Number.isFinite(tsMs) && tsMs >= cutoffMs) {
        count += 1;
      }
    }
  }
  return count;
}
