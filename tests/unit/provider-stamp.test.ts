/**
 * Anti-confab provider stamp — sprint 2026-05-04.
 *
 * Bot was claiming "ja, cogito:3b" / "Pisałem to sam" while the actual
 * provider was MiniMax. Source-of-truth fix: the runtime appends a
 * "— via {provider}/{model}" footer to every reply across every
 * surface so the operator (and any later auditor reading persisted
 * sessions) sees who actually generated the text.
 *
 * This file pins the helper's contract:
 *   - default ON, regardless of provider/model
 *   - idempotent (won't double-stamp when model imitates the format)
 *   - suppressed via MEMPHIS_PROVIDER_STAMP=0 / false
 *   - safe against missing/empty provider or model strings
 */
import { describe, expect, it } from 'vitest';

import { appendProviderStamp } from '../../src/gateway/turn-runtime.js';

describe('appendProviderStamp', () => {
  it('appends "— via provider/model" by default', () => {
    const out = appendProviderStamp('Cześć!', 'minimax', 'MiniMax-M2.7', {});
    expect(out).toBe('Cześć!\n\n— via minimax/MiniMax-M2.7');
  });

  it('preserves the original body verbatim', () => {
    const body = '## Status\n\nBloki: 2883\nVault: 4 wpisy';
    const out = appendProviderStamp(body, 'ollama', 'cogito:3b', {});
    expect(out.startsWith(body)).toBe(true);
    expect(out.endsWith('— via ollama/cogito:3b')).toBe(true);
  });

  it('trims trailing whitespace before the footer (no orphan blank lines)', () => {
    const out = appendProviderStamp('text\n\n\n\n', 'ollama', 'cogito:3b', {});
    // exactly one blank line between body and footer
    expect(out).toBe('text\n\n— via ollama/cogito:3b');
  });

  it('suppresses footer when MEMPHIS_PROVIDER_STAMP=0', () => {
    const out = appendProviderStamp('hi', 'minimax', 'MiniMax-M2.7', {
      MEMPHIS_PROVIDER_STAMP: '0',
    });
    expect(out).toBe('hi');
  });

  it('suppresses footer when MEMPHIS_PROVIDER_STAMP=false', () => {
    const out = appendProviderStamp('hi', 'minimax', 'MiniMax-M2.7', {
      MEMPHIS_PROVIDER_STAMP: 'false',
    });
    expect(out).toBe('hi');
  });

  it('does not double-stamp when reply already ends with a "— via X/Y" line', () => {
    // A pathological model that imitates the footer in its own reply
    // shouldn't get a second one bolted on.
    const already = 'sample reply\n\n— via somebody/something';
    const out = appendProviderStamp(already, 'minimax', 'MiniMax-M2.7', {});
    expect(out).toBe(already);
  });

  it('falls back to "unknown" when provider or model is empty', () => {
    expect(appendProviderStamp('hi', '', 'M', {})).toMatch(/— via unknown\/M$/);
    expect(appendProviderStamp('hi', 'P', '', {})).toMatch(/— via P\/unknown$/);
    expect(appendProviderStamp('hi', '', '', {})).toMatch(/— via unknown\/unknown$/);
  });
});
