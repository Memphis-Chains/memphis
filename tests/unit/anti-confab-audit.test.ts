/**
 * Sprint Continue 2 phase 1 — runtime anti-confab audit.
 *
 * Pin the detector behavior across positive (claim+tool), violation
 * (claim, no tool), false-positive (claim quoted from chain hit), and
 * category-mix cases. The detector is fail-open by design (log-only),
 * so the unit tests are the strongest guarantee its semantics stay
 * sane as we tune phrase lists later.
 */
import { describe, expect, it } from 'vitest';

import {
  detectConfabulationClaims,
  extractToolsCalled,
} from '../../src/gateway/anti-confab-audit.js';
import type { ChatMessage } from '../../src/providers/index.js';

describe('detectConfabulationClaims', () => {
  // ── Persistence category ──────────────────────────────────────────────

  it('flags "zapisałem" when no write tool was called', () => {
    const result = detectConfabulationClaims('Wszystko zapisałem.', new Set());
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe('persistence');
    expect(result.violations[0].phrase).toBe('zapisałem');
  });

  it('does NOT flag "zapisałem" when memphis_soul_write fired', () => {
    const result = detectConfabulationClaims(
      'Wszystko zapisałem.',
      new Set(['memphis_soul_write']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('flags English "I saved" without a write tool', () => {
    const result = detectConfabulationClaims(
      'OK, I saved your preferences.',
      new Set(['memphis_recall']),
    );
    // memphis_recall is a search tool, not a persistence tool — claim still violation
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].category).toBe('persistence');
  });

  it('skips persistence claims when memphis_journal fired (whitelist hit)', () => {
    const result = detectConfabulationClaims(
      'Done. Saved to journal.',
      new Set(['memphis_journal']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('flags "Tworzę plik" without memphis_fs_write (2026-05-05 incident)', () => {
    // Operator session 2026-05-05 16:06 + 16:19: bot announced
    // "Tworzę teraz plik HTML" twice without ever calling
    // memphis_fs_write — XML parser bug (#491) ate the tool call,
    // but the detector also missed the claim itself. This test pins
    // the new forbidden phrases.
    const result = detectConfabulationClaims(
      'Tworzę teraz plik HTML z pełną analizą.',
      new Set(),
    );
    const persistenceViolations = result.violations.filter((v) => v.category === 'persistence');
    expect(persistenceViolations.length).toBeGreaterThanOrEqual(1);
    // Either phrase variant counts — the test sentence contains both
    // "tworzę plik" (substring of "tworzę teraz plik" would match first
    // since it's the longer sequence). Either match is the right signal.
    expect(persistenceViolations.map((v) => v.phrase)).toEqual(
      expect.arrayContaining([expect.stringMatching(/tworzę.*plik/u)]),
    );
  });

  it('does NOT flag "Tworzę plik" when memphis_fs_write fired (whitelist hit)', () => {
    const result = detectConfabulationClaims(
      'Tworzę plik HTML z analizą.',
      new Set(['memphis_fs_write']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('flags English "creating file" without a write tool', () => {
    const result = detectConfabulationClaims(
      "I'm creating a file with the report.",
      new Set(),
    );
    const persistenceViolations = result.violations.filter((v) => v.category === 'persistence');
    expect(persistenceViolations.length).toBeGreaterThanOrEqual(1);
  });

  // ── Search category ───────────────────────────────────────────────────

  it('flags "Przeszukałem cały src/" when no read tool was called', () => {
    const result = detectConfabulationClaims(
      'Przeszukałem cały src/, nie ma whisper.',
      new Set(),
    );
    // Match "przeszukałem"; "nie ma w src/" is a separate phrase that
    // also fires here — both count as violations of the same category.
    const searchViolations = result.violations.filter((v) => v.category === 'search');
    expect(searchViolations.length).toBeGreaterThanOrEqual(1);
    expect(searchViolations.map((v) => v.phrase)).toContain('przeszukałem');
  });

  it('does NOT flag "Przeszukałem" when memphis_exec fired', () => {
    const result = detectConfabulationClaims(
      'Przeszukałem src/. Found 4 matches via grep.',
      new Set(['memphis_exec']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('flags English "I searched" without a read tool', () => {
    const result = detectConfabulationClaims('I searched the repo, nothing found.', new Set());
    const searchViolations = result.violations.filter((v) => v.category === 'search');
    expect(searchViolations).toHaveLength(1);
    expect(searchViolations[0].phrase).toBe('i searched');
  });

  it('memphis_brave_search whitelists web-search claims (real search happened)', () => {
    // Bot called memphis_brave_search and reports the result honestly.
    // Without this whitelist entry the otherwise-truthful "I searched
    // the web" would false-positive as a search-claim violation.
    const result = detectConfabulationClaims(
      'I searched the web for "quantum cryptography migration plans" — nothing relevant.',
      new Set(['memphis_brave_search']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('memphis_web_search whitelists web-search claims (DuckDuckGo fallback)', () => {
    const result = detectConfabulationClaims(
      'Szukałem w sieci, znalazłem 3 wyniki.',
      new Set(['memphis_web_search']),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('memphis_recall whitelists search-claim but NOT persistence-claim', () => {
    // Mixed reply: search claim is OK (recall ran), persistence claim is not
    // (no write tool ran).
    const result = detectConfabulationClaims(
      'Sprawdziłem — szukałem w pamięci. Zaktualizowałem profil.',
      new Set(['memphis_recall']),
    );
    expect(result.violations.map((v) => v.category)).not.toContain('search');
    expect(result.violations.map((v) => v.category)).toContain('persistence');
  });

  // ── Capability category ───────────────────────────────────────────────

  it('flags "I have access to" without memphis_self_describe', () => {
    const result = detectConfabulationClaims(
      'I have access to 12 tools and 3 chains.',
      new Set(['memphis_recall']),
    );
    expect(result.violations.map((v) => v.category)).toContain('capability');
  });

  it('does NOT flag capability claims when memphis_self_describe fired', () => {
    const result = detectConfabulationClaims(
      'My available tools are: memphis_recall, memphis_search.',
      new Set(['memphis_self_describe']),
    );
    expect(result.violations).toHaveLength(0);
  });

  // ── False-positive guard: quoted text ────────────────────────────────

  it('does NOT flag forbidden phrase when wrapped in ASCII quotes', () => {
    const result = detectConfabulationClaims(
      'The journal entry says: "I saved the password" — that was last week.',
      new Set(),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('does NOT flag forbidden phrase appearing inside [chain_hits] context', () => {
    const reply = [
      '[chain_hits]',
      '- journal#5 score=0.91 user wrote: I searched everywhere',
      '',
      'You asked about kitchen tools.',
    ].join('\n');
    const result = detectConfabulationClaims(reply, new Set());
    expect(result.violations).toHaveLength(0);
  });

  it('does NOT flag phrase right after a journal#N citation', () => {
    const result = detectConfabulationClaims(
      'Per journal#42 from Tuesday: I saved the report there.',
      new Set(),
    );
    expect(result.violations).toHaveLength(0);
  });

  // ── No-violation cases ───────────────────────────────────────────────

  it('returns no violations on a benign reply', () => {
    const result = detectConfabulationClaims(
      'Cześć, jak mogę pomóc?',
      new Set(),
    );
    expect(result.violations).toHaveLength(0);
  });

  it('handles empty reply gracefully', () => {
    const result = detectConfabulationClaims('', new Set());
    expect(result.violations).toHaveLength(0);
  });

  // ── Word-boundary discipline ─────────────────────────────────────────

  it('does NOT flag the substring "saved" inside an unrelated word like "savedness"', () => {
    // No real English word "savedness" but exercises the boundary check —
    // "i saved" is multi-word so the boundary check fires on the start
    // (preceding non-letter) rather than the end. The phrase still has
    // to be a complete substring; this should not match a longer-glued
    // sequence.
    const result = detectConfabulationClaims('savedi savedfoo bar', new Set());
    // The phrase "i saved" is in there ("…savedi saved…") with a
    // letter on the right boundary ('foo') so it should NOT match.
    expect(result.violations).toHaveLength(0);
  });
});

describe('extractToolsCalled', () => {
  it('returns empty set when there are no assistant tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    expect(extractToolsCalled(messages).size).toBe(0);
  });

  it('collects tool names from assistant tool_calls across the message list', () => {
    // extractToolsCalled reads `call.name` directly — that's the shape
    // chat-loop history holds. The OpenAI-style nested `function.name`
    // is normalized upstream, so the audit sees flat `{name: ...}`.
    const messages: ChatMessage[] = [
      { role: 'user', content: 'find foo' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'memphis_search' }],
      } as unknown as ChatMessage,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'memphis_journal' }],
      } as unknown as ChatMessage,
    ];
    const tools = extractToolsCalled(messages);
    expect(tools.has('memphis_search')).toBe(true);
    expect(tools.has('memphis_journal')).toBe(true);
  });
});
