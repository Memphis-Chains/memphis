/**
 * Anti-confab provider stamp — sprint 2026-05-04, flipped to opt-in
 * 2026-05-12.
 *
 * Original problem: bot was claiming "ja, cogito:3b" / "Pisałem to sam"
 * while the actual provider was MiniMax. The fix added a "— via
 * {provider}/{model}" footer so operators (and any later auditor
 * reading persisted sessions) could trace who generated the text.
 *
 * 2026-05-12 flip: operator confirmed the in-body footer was noise on
 * operator-facing surfaces and frequently misleading when provider
 * cascade switched mid-call. Default is now OFF — set
 * MEMPHIS_PROVIDER_STAMP=1 to bring the footer back for bisecting
 * misroutes. Legacy "=0" still honored (no-op redundancy).
 *
 * This file pins the helper's contract:
 *   - default OFF
 *   - emits the footer when MEMPHIS_PROVIDER_STAMP=1 / true
 *   - idempotent (won't double-stamp when model imitates the format)
 *   - safe against missing/empty provider or model strings
 */
import { describe, expect, it } from 'vitest';

import { appendProviderStamp } from '../../src/gateway/turn-runtime.js';

describe('appendProviderStamp', () => {
  const ON = { MEMPHIS_PROVIDER_STAMP: '1' };

  it('passes the body through verbatim by default (flag unset)', () => {
    const out = appendProviderStamp('Cześć!', 'minimax', 'MiniMax-M2.7', {});
    expect(out).toBe('Cześć!');
  });

  it('passes the body through verbatim when MEMPHIS_PROVIDER_STAMP=0 (legacy off)', () => {
    const out = appendProviderStamp('hi', 'minimax', 'MiniMax-M2.7', {
      MEMPHIS_PROVIDER_STAMP: '0',
    });
    expect(out).toBe('hi');
  });

  it('passes the body through verbatim when MEMPHIS_PROVIDER_STAMP=false (legacy off)', () => {
    const out = appendProviderStamp('hi', 'minimax', 'MiniMax-M2.7', {
      MEMPHIS_PROVIDER_STAMP: 'false',
    });
    expect(out).toBe('hi');
  });

  it('appends "— via provider/model" when MEMPHIS_PROVIDER_STAMP=1', () => {
    const out = appendProviderStamp('Cześć!', 'minimax', 'MiniMax-M2.7', ON);
    expect(out).toBe('Cześć!\n\n— via minimax/MiniMax-M2.7');
  });

  it('preserves the original body verbatim under MEMPHIS_PROVIDER_STAMP=1', () => {
    const body = '## Status\n\nBloki: 2883\nVault: 4 wpisy';
    const out = appendProviderStamp(body, 'ollama', 'cogito:3b', ON);
    expect(out.startsWith(body)).toBe(true);
    expect(out.endsWith('— via ollama/cogito:3b')).toBe(true);
  });

  it('trims trailing whitespace before the footer (no orphan blank lines)', () => {
    const out = appendProviderStamp('text\n\n\n\n', 'ollama', 'cogito:3b', ON);
    // exactly one blank line between body and footer
    expect(out).toBe('text\n\n— via ollama/cogito:3b');
  });

  it('does not double-stamp when reply already ends with a "— via X/Y" line', () => {
    // A pathological model that imitates the footer in its own reply
    // shouldn't get a second one bolted on.
    const already = 'sample reply\n\n— via somebody/something';
    const out = appendProviderStamp(already, 'minimax', 'MiniMax-M2.7', ON);
    expect(out).toBe(already);
  });

  it('falls back to "unknown" when provider or model is empty (stamp on)', () => {
    expect(appendProviderStamp('hi', '', 'M', ON)).toMatch(/— via unknown\/M$/);
    expect(appendProviderStamp('hi', 'P', '', ON)).toMatch(/— via P\/unknown$/);
    expect(appendProviderStamp('hi', '', '', ON)).toMatch(/— via unknown\/unknown$/);
  });
});
