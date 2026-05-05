/**
 * Runtime audit for confabulation claims (Sprint Continue 2 phase 1).
 *
 * The system prompt forbids three categories of claims when no
 * matching tool ran in the turn:
 *
 *   - persistence-claim (#473) — "saved", "zapisane", etc.
 *   - search-claim (#478)      — "I searched", "przeszukałem", etc.
 *   - capability-claim (#465)  — concrete tool/tier/flag enumerations
 *                                without `memphis_self_describe` call
 *
 * Until now those rules lived only in the prompt text. Models honor
 * them mostly, but the 2026-05-05 incidents (Lądunę confab, "Przeszukałem
 * cały src/" confab) prove the prompt alone is insufficient — small
 * models in concise modes (mode A) skip the discipline.
 *
 * This module adds the runtime side: after every turn, scan the reply
 * for category-specific forbidden phrases and cross-reference the
 * tool-call audit. If a forbidden phrase appears WITHOUT the matching
 * write/read/introspect tool firing in the same turn, that's a
 * confabulation violation — emit a runtime security event so the
 * operator (and future training loops) can see the pattern.
 *
 * Phase 1 = log only. The reply is not modified or rejected. We need
 * production telemetry across diverse turn shapes before we trust
 * the detector to fail-closed. Phase 2 (future PR) will append a
 * runtime warning to the reply or reject outright.
 *
 * ## False-positive handling
 *
 * A reply may legitimately contain a forbidden phrase if it's quoting
 * a chain hit ("the journal#5 entry says: 'I searched for X'") or
 * paraphrasing the user. The detector ignores phrases that appear
 * inside common quotation patterns (`"…"`, `«…»`, ` — `, `: …`)
 * to keep the false-positive rate low.
 */

import type { ChatMessage } from '../providers/index.js';

export type ConfabClaimCategory = 'persistence' | 'search' | 'capability';

export interface ConfabClaimViolation {
  category: ConfabClaimCategory;
  phrase: string;
  /** Up to 80 chars of surrounding text for the audit log */
  excerpt: string;
}

export interface ConfabAuditResult {
  violations: ConfabClaimViolation[];
}

/**
 * Forbidden phrases per category. Mirrors the system-prompt sections
 * but kept in code so the runtime detector and the prompt stay in
 * sync. If you update the prompt, update this list too.
 *
 * Phrases are matched case-insensitively as whole-word/phrase fragments.
 * Polish diacritics are kept verbatim (matched on the same code points
 * the model emits).
 */
const FORBIDDEN_PHRASES: Record<ConfabClaimCategory, readonly string[]> = {
  persistence: [
    // Polish — past-tense or present "I am saving" claims
    'zapisałem',
    'zapisaliśmy',
    'zaktualizowałem',
    'wpisałem',
    'zachowałem',
    // Polish — passive participles operators read as "done"
    'zapisane',
    'zapisana',
    'zapamiętane',
    'zaktualizowane',
    'wpisane',
    'zachowane',
    // English
    'i saved',
    'i persisted',
    'i stored',
    'i committed',
    'i recorded',
    'i wrote it',
    'i updated',
  ],
  search: [
    // Polish
    'przeszukałem',
    'przeszukałam',
    'szukałem',
    'szukałam',
    'grepowałem',
    'sprawdziłem kod',
    'sprawdziłam kod',
    'patrzyłem w kodzie',
    'nie znalazłem w kodzie',
    'nie ma w src/',
    'przeszedłem przez kod',
    // English
    'i searched',
    'i scanned',
    'i grepped',
    'i checked the source',
    'i looked through',
    "couldn't find in src/",
    'not in src/',
  ],
  capability: [
    // Concrete enumerations bot should source from memphis_self_describe.
    // We match patterns like "I have N tools" / "tier 2 grants X / Y / Z" — these
    // are common confab shapes. Generic capability talk ("I can help you with…")
    // is allowed.
    'i have access to',
    'my available tools are',
    'my tier grants',
  ],
};

/**
 * Whitelisted tools per category. If ANY of these tools fired in the
 * turn, the corresponding category's forbidden phrases are allowed
 * (the bot earned the right to make the claim by actually doing the
 * work).
 */
const WHITELISTED_TOOLS: Record<ConfabClaimCategory, readonly string[]> = {
  persistence: [
    'memphis_soul_write',
    'memphis_journal',
    'memphis_decide',
    'memphis_case_append',
    'memphis_self_modify',
    'memphis_capture',
    'memphis_provider_set',
  ],
  search: [
    'memphis_recall',
    'memphis_search',
    'memphis_chain_query',
    'memphis_case_query',
    'memphis_exec',
    'memphis_web_fetch',
  ],
  capability: ['memphis_self_describe', 'memphis_providers', 'memphis_health'],
};

/**
 * Extract the set of tool names that were invoked by the assistant
 * in this turn. Mirrors `extractFrameToolCalls` in turn-runtime.ts
 * (kept duplicated rather than imported to avoid a circular shape).
 */
export function extractToolsCalled(messages: ChatMessage[]): Set<string> {
  const names = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    const toolCalls = (msg as ChatMessage & { tool_calls?: { name?: string }[] }).tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const call of toolCalls) {
      if (call?.name) names.add(call.name);
    }
  }
  return names;
}

/**
 * Heuristic for "this phrase looks like it's being quoted from
 * elsewhere, not asserted by the bot itself". A claim wrapped in
 * quotes, dashes, or appearing on its own block-line after a colon
 * is treated as quotation and excused.
 *
 * The regex windows are crude on purpose — we'd rather miss a real
 * violation than emit a false positive that erodes operator trust
 * in the audit signal.
 */
function looksQuoted(haystack: string, phraseStart: number, phraseEnd: number): boolean {
  // Slightly larger window to catch closing quotes that come after a few
  // words of quoted material ("…says: \"I saved the password\" …")
  const windowStart = Math.max(0, phraseStart - 64);
  const windowEnd = Math.min(haystack.length, phraseEnd + 64);
  const before = haystack.slice(windowStart, phraseStart);
  const after = haystack.slice(phraseEnd, windowEnd);

  // After a [chain_hits] marker the whole block is quoted-from-disk —
  // treat anything matching as quotation regardless of inner shape.
  if (/\[chain_hits\][\s\S]{0,400}$/u.test(haystack.slice(0, phraseStart))) return true;

  // Right after a journal/case/decision entry header — citation, not bot's claim
  if (/(?:journal|decisions?|cases?|reflections?)#\d+[\s\S]{0,80}$/u.test(before)) return true;

  // Wrapping ASCII / fancy quotes around a short phrase. We look for an
  // OPENING quote in the 64 chars before the phrase + a CLOSING quote in
  // the 64 chars after. The window is short enough that bare quotes
  // appearing far apart don't accidentally couple.
  const openingQuote = /["'`«»“„«]/.test(before);
  const closingQuote = /["'`«»”»]/.test(after);
  if (openingQuote && closingQuote) {
    // Plus: between the opening quote and the phrase there should not
    // be another closing quote of the matching type — otherwise we'd be
    // outside the quoted span. Cheap proxy: check that the substring
    // after the LAST opening quote in `before` does not itself contain
    // a closing quote.
    const lastOpenIdx = Math.max(
      before.lastIndexOf('"'),
      before.lastIndexOf("'"),
      before.lastIndexOf('`'),
      before.lastIndexOf('«'),
      before.lastIndexOf('“'),
      before.lastIndexOf('„'),
    );
    if (lastOpenIdx >= 0) {
      const tail = before.slice(lastOpenIdx + 1);
      // If the tail between opening quote and the phrase contains a
      // closing quote, we're outside the quoted span.
      if (!/["'`»”]/.test(tail)) return true;
    }
  }

  // Quote-introducer colon ("the operator said: …" or em-dash) at start
  // of line — bot is reporting what someone said, not asserting.
  if (/[:—]\s*"?\s*$/u.test(before) && /^[^"\n]*"\s*/u.test(after)) return true;

  return false;
}

function findPhraseMatches(
  haystack: string,
  phrases: readonly string[],
): { phrase: string; start: number; end: number; excerpt: string }[] {
  const matches: { phrase: string; start: number; end: number; excerpt: string }[] = [];
  const lower = haystack.toLowerCase();
  for (const phrase of phrases) {
    const needle = phrase.toLowerCase();
    let from = 0;
    while (true) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const end = idx + needle.length;
      // Crude word-boundary: char before/after must not be a letter
      const charBefore = idx > 0 ? haystack[idx - 1] : ' ';
      const charAfter = end < haystack.length ? haystack[end] : ' ';
      const isWordBoundaryBefore = !/[\p{L}\p{N}_]/u.test(charBefore);
      const isWordBoundaryAfter = !/[\p{L}\p{N}_]/u.test(charAfter);
      if (isWordBoundaryBefore && isWordBoundaryAfter) {
        const excerptStart = Math.max(0, idx - 24);
        const excerptEnd = Math.min(haystack.length, end + 24);
        const excerpt = haystack.slice(excerptStart, excerptEnd).replace(/\s+/g, ' ').trim();
        matches.push({ phrase, start: idx, end, excerpt });
      }
      from = end;
    }
  }
  return matches;
}

/**
 * Scan a model reply for confabulation violations. Returns the list
 * of violations (empty if all forbidden-phrase categories are either
 * absent or accompanied by a whitelisted tool call).
 */
export function detectConfabulationClaims(
  reply: string,
  toolsCalledInTurn: Iterable<string>,
): ConfabAuditResult {
  const toolSet = new Set(toolsCalledInTurn);
  const violations: ConfabClaimViolation[] = [];

  for (const category of Object.keys(FORBIDDEN_PHRASES) as ConfabClaimCategory[]) {
    // If any whitelisted tool for this category fired, skip the whole
    // category — the bot earned the right to make these claims.
    const whitelistHit = WHITELISTED_TOOLS[category].some((name) => toolSet.has(name));
    if (whitelistHit) continue;

    const matches = findPhraseMatches(reply, FORBIDDEN_PHRASES[category]);
    for (const match of matches) {
      if (looksQuoted(reply, match.start, match.end)) continue;
      violations.push({
        category,
        phrase: match.phrase,
        excerpt: match.excerpt,
      });
    }
  }

  return { violations };
}
