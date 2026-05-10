import { describe, expect, it } from 'vitest';

import type { ConfabAuditResult } from '../../src/gateway/anti-confab-audit.js';
import {
  appendConfabWarning,
  resolveConfabPhase,
  type ConfabMitigationPhase,
} from '../../src/gateway/turn-runtime.js';

/**
 * Anti-confab Phase 2 — runtime warning footer + Phase 3 sentence
 * stripping. The detector lives in `anti-confab-audit.ts` (covered by
 * `anti-confab-audit.test.ts`); this suite focuses on the reply-mutation
 * side that operators actually see.
 */

const persistenceViolation: ConfabAuditResult = {
  violations: [
    {
      category: 'persistence',
      phrase: 'zapisałem',
      excerpt: '… zapisałem journal entry …',
    },
  ],
};

const multiViolation: ConfabAuditResult = {
  violations: [
    { category: 'persistence', phrase: 'zapisałem', excerpt: '… zapisałem …' },
    { category: 'search', phrase: 'przeszukałem', excerpt: '… przeszukałem src/ …' },
    { category: 'capability', phrase: 'i have access to', excerpt: '… i have access to …' },
  ],
};

const noViolations: ConfabAuditResult = { violations: [] };

describe('resolveConfabPhase', () => {
  it('defaults to phase 2 when env unset', () => {
    expect(resolveConfabPhase({})).toBe(2 satisfies ConfabMitigationPhase);
  });

  it('respects explicit MEMPHIS_ANTICONFAB_PHASE values', () => {
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '0' })).toBe(0);
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '1' })).toBe(1);
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '2' })).toBe(2);
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '3' })).toBe(3);
  });

  it('falls back to default when env value is unrecognized', () => {
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: 'on' })).toBe(2);
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '4' })).toBe(2);
    expect(resolveConfabPhase({ MEMPHIS_ANTICONFAB_PHASE: '' })).toBe(2);
  });
});

describe('appendConfabWarning — Phase 2 (warn-append, default)', () => {
  it('appends a footer when violations are present', () => {
    const reply = 'Wszystko zrobione, zapisałem do journala.';
    const out = appendConfabWarning(reply, persistenceViolation, 2);
    expect(out).toContain(reply.trimEnd());
    expect(out).toMatch(/\[memphis: claim flagged as unverified — persistence: "zapisałem"/);
    expect(out).toMatch(/no matching tool was invoked this turn/);
  });

  it('mentions the count when more than one violation fired', () => {
    const out = appendConfabWarning('Done.', multiViolation, 2);
    // First violation in the lead, +N more in the tail.
    expect(out).toMatch(/persistence: "zapisałem"/);
    expect(out).toMatch(/\(\+2 more violations\)/);
  });

  it('passes through unchanged when no violations', () => {
    const reply = 'Plain reply with no claim.';
    expect(appendConfabWarning(reply, noViolations, 2)).toBe(reply);
  });

  it('passes through unchanged at phase 0 even with violations', () => {
    const reply = 'Done, zapisałem.';
    expect(appendConfabWarning(reply, persistenceViolation, 0)).toBe(reply);
  });

  it('passes through unchanged at phase 1 (log-only)', () => {
    const reply = 'Done, zapisałem.';
    expect(appendConfabWarning(reply, persistenceViolation, 1)).toBe(reply);
  });

  it('keeps trailing whitespace clean — no double newlines before footer', () => {
    const reply = 'Sample reply with trailing newlines\n\n\n';
    const out = appendConfabWarning(reply, persistenceViolation, 2);
    // Must be exactly one paragraph break before the footer.
    expect(out).not.toMatch(/\n\n\n\n+\[memphis:/);
    expect(out).toMatch(/Sample reply with trailing newlines\n\n\[memphis:/);
  });
});

describe('appendConfabWarning — Phase 3 (strip-sentence, opt-in)', () => {
  it('removes the sentence containing the offending phrase', () => {
    const reply = 'Cześć! Zapisałem rezultat do journala. Reszta wygląda dobrze.';
    const out = appendConfabWarning(reply, persistenceViolation, 3);
    // The middle sentence is gone; the surrounding sentences remain.
    expect(out).toMatch(/Cześć!/);
    expect(out).toMatch(/Reszta wygląda dobrze\./);
    expect(out).not.toMatch(/Zapisałem/);
  });

  it('handles violation at the very start of the reply', () => {
    const reply = 'Zapisałem od razu. Tutaj kod.';
    const out = appendConfabWarning(reply, persistenceViolation, 3);
    expect(out).not.toMatch(/Zapisałem/);
    expect(out).toMatch(/Tutaj kod\./);
  });

  it('handles violation at the very end of the reply', () => {
    const reply = 'Tutaj kod. Zapisałem.';
    const out = appendConfabWarning(reply, persistenceViolation, 3);
    expect(out).toMatch(/Tutaj kod\./);
    expect(out).not.toMatch(/Zapisałem/);
  });

  it('strips multiple sentences when multiple violations are present', () => {
    const reply = 'Zapisałem journal. Przeszukałem src. Reszta jest niezmieniona.';
    const out = appendConfabWarning(reply, multiViolation, 3);
    expect(out).not.toMatch(/Zapisałem/);
    expect(out).not.toMatch(/Przeszukałem/);
    expect(out).toMatch(/Reszta jest niezmieniona\./);
  });

  it('passes through unchanged when no violations', () => {
    const reply = 'Plain.';
    expect(appendConfabWarning(reply, noViolations, 3)).toBe(reply);
  });
});

describe('appendConfabWarning — splice ordering (regression vs. provider stamp)', () => {
  it('produces a footer that does NOT contain the provider stamp pattern', () => {
    // The chain in turn-runtime.ts is: stripThinkBlocks → +truncationNote
    // → appendConfabWarning → appendProviderStamp. The warning must
    // come BEFORE the stamp so the visible tail is:
    //   [memphis: claim flagged …] — via anthropic/claude-sonnet-4-6
    //
    // Here we just assert the warning text doesn't accidentally include
    // a `— via` pattern (it doesn't, but let's lock that in).
    const out = appendConfabWarning('Reply.', persistenceViolation, 2);
    expect(out).not.toMatch(/— via /);
  });
});
