/**
 * Pins the UTF-8-aware truncation contract for the embed pipeline.
 *
 * Live observation 2026-05-12: 38 insight blocks (8-10 KB JSON dumps)
 * silently rejected by the Rust embed pipeline (`text too large:
 * 8970 bytes exceeds max 4096`). Codex review #585 caught that a naive
 * `text.slice(0, 4000)` truncate would still let Polish or emoji text
 * exceed the 4096-UTF-8-byte budget because JS string slice counts
 * UTF-16 code units. These tests pin the correct behaviour so a
 * future refactor can't drop back to the byte-unsafe path.
 */
import { describe, expect, it } from 'vitest';

import { truncateUtf8 } from '../../src/infra/memory/embed-reindex.js';

describe('truncateUtf8', () => {
  it('returns the original string when already within budget', () => {
    expect(truncateUtf8('hello', 100)).toBe('hello');
    expect(truncateUtf8('', 100)).toBe('');
  });

  it('cuts ASCII text at the byte budget and appends marker', () => {
    const text = 'a'.repeat(5000);
    const out = truncateUtf8(text, 4000);
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(4000 + 22); // + '\n[truncated for embed]'
    expect(out.endsWith('[truncated for embed]')).toBe(true);
    expect(out.startsWith('aaaa')).toBe(true);
  });

  it('counts UTF-8 bytes (not UTF-16 chars) for multibyte input', () => {
    // Polish "ą" is 2 UTF-8 bytes. 3000 "ą" = 6000 bytes > 4096 budget.
    // A naive `.slice(0, 4000)` would keep 4000 chars = 8000 bytes —
    // still over budget and the Rust pipeline would reject. The
    // UTF-8-aware truncate must clip past the actual byte limit.
    const text = 'ą'.repeat(3000);
    expect(Buffer.byteLength(text, 'utf8')).toBe(6000);
    const out = truncateUtf8(text, 4000);
    // 'ą' marker line is 22 bytes; cut body must fit in 4000 bytes.
    const bodyBytes = Buffer.byteLength(out.replace(/\n\[truncated for embed\]$/, ''), 'utf8');
    expect(bodyBytes).toBeLessThanOrEqual(4000);
    expect(out.endsWith('[truncated for embed]')).toBe(true);
  });

  it('does not split a multibyte codepoint at the cut boundary', () => {
    // Construct text where the byte-budget edge falls in the middle
    // of a 4-byte emoji. The truncator must walk back to the start of
    // that codepoint, not leave a half-emoji.
    // 😀 = 4 UTF-8 bytes (F0 9F 98 80). Pad with 3998 ASCII bytes so
    // the cut would land at byte 4000 = position 2 inside the emoji.
    const text = 'a'.repeat(3998) + '😀😀😀';
    const out = truncateUtf8(text, 4000);
    // Every codepoint in the truncated body must survive decode —
    // String#length counting and re-encoding both succeed without
    // replacement chars (U+FFFD).
    const body = out.replace(/\n\[truncated for embed\]$/, '');
    expect(body).not.toContain('�');
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(4000);
  });

  it('handles an empty budget gracefully (degenerate edge)', () => {
    // maxBytes=0 with non-empty input should still emit the marker
    // rather than throw; the rest of the pipeline can refuse it.
    const out = truncateUtf8('hello', 0);
    expect(out).toBe('\n[truncated for embed]');
  });
});
