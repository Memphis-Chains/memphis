/**
 * Pins the chunk-and-multi-vector contract for long content. Codex
 * review #585 finding #4: when a block exceeds the Rust embed
 * pipeline's 4096-byte limit, we now split into overlapping windows
 * and store each as a separate vector — keyed by a per-chunk `#cN`
 * suffix so the Rust embed HashMap doesn't overwrite them.
 *
 * Recall-side dedup (`mapSemanticHits` in recall.ts) collapses the
 * multi-chunk hits back to one entry per source block (max-pool by
 * score), so operators never see the same long insight five times
 * in a row at top-K.
 */
import { describe, expect, it } from 'vitest';

import {
  baseMemoryIdFromChunkId,
  buildChunkEmbedId,
  chunkForEmbed,
} from '../../src/infra/memory/embed-reindex.js';

describe('chunkForEmbed', () => {
  it('returns the input verbatim as one chunk when it already fits', () => {
    const out = chunkForEmbed('hello world', 4000);
    expect(out).toHaveLength(1);
    expect(out[0]?.chunkIdx).toBe(0);
    expect(out[0]?.text).toBe('hello world');
  });

  it('splits ASCII text into N chunks all within the byte budget', () => {
    const text = 'a'.repeat(12_000);
    const out = chunkForEmbed(text, 4000);
    expect(out.length).toBeGreaterThan(2); // 12k bytes / 4k window = at least 3 chunks
    for (const c of out) {
      expect(Buffer.byteLength(c.text, 'utf8')).toBeLessThanOrEqual(4000);
    }
    // Chunk indices monotonic from 0.
    expect(out.map((c) => c.chunkIdx)).toEqual(Array.from({ length: out.length }, (_, i) => i));
  });

  it('overlaps consecutive chunks for semantic continuity (default 200 bytes)', () => {
    const text = 'a'.repeat(10_000);
    const out = chunkForEmbed(text, 4000, 200);
    // Each adjacent pair should share at least some overlap bytes;
    // exact alignment depends on the byte-boundary walk-back, but
    // consecutive chunk pairs should not be wholly disjoint.
    for (let i = 0; i < out.length - 1; i += 1) {
      const a = out[i]!.text;
      const b = out[i + 1]!.text;
      const overlap = a.slice(-200);
      // Some prefix of b matches the tail of a.
      expect(b.startsWith(overlap.slice(0, 50))).toBe(true);
    }
  });

  it('never splits a multi-byte codepoint at a chunk boundary', () => {
    // Polish "ą" = 2 UTF-8 bytes; pack a long string of them so cuts
    // land mid-codepoint repeatedly. None of the chunks should end with
    // a half codepoint (`Buffer.toString('utf8')` would surface a
    // U+FFFD if it did).
    const text = 'ą'.repeat(4000);
    const out = chunkForEmbed(text, 4000);
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) {
      expect(c.text).not.toContain('�'); // replacement char on split
      expect(Buffer.byteLength(c.text, 'utf8')).toBeLessThanOrEqual(4000);
    }
  });

  it('handles 4-byte emoji on the boundary', () => {
    // 😀 = 4 UTF-8 bytes. Pack to land cut inside one.
    const text = 'a'.repeat(3998) + '😀'.repeat(2000);
    const out = chunkForEmbed(text, 4000);
    for (const c of out) {
      expect(c.text).not.toContain('�');
      expect(Buffer.byteLength(c.text, 'utf8')).toBeLessThanOrEqual(4000);
    }
  });

  it('respects degenerate maxBytes <= 0 by returning a single passthrough chunk', () => {
    // Belt-and-braces: would otherwise loop forever. Caller should
    // never pass 0; if they do, give a coherent fallback.
    const out = chunkForEmbed('hello', 0);
    expect(out).toEqual([{ chunkIdx: 0, text: 'hello' }]);
  });
});

describe('buildChunkEmbedId + baseMemoryIdFromChunkId', () => {
  it('keeps the original id when there is only one chunk (backward compat)', () => {
    expect(buildChunkEmbedId('journal-42', 0, 1)).toBe('journal-42');
  });

  it('appends #cN suffix when there are multiple chunks', () => {
    expect(buildChunkEmbedId('journal-42', 0, 3)).toBe('journal-42#c0');
    expect(buildChunkEmbedId('journal-42', 2, 3)).toBe('journal-42#c2');
  });

  it('round-trips: chunk id back to base id', () => {
    expect(baseMemoryIdFromChunkId('journal-42#c0')).toBe('journal-42');
    expect(baseMemoryIdFromChunkId('journal-42#c5')).toBe('journal-42');
  });

  it('returns the input unchanged for non-chunked ids', () => {
    expect(baseMemoryIdFromChunkId('journal-42')).toBe('journal-42');
    expect(baseMemoryIdFromChunkId('insights-7')).toBe('insights-7');
  });

  it('does not strip non-numeric `#c` patterns', () => {
    // Legitimate content like `mem-id#config` must survive.
    expect(baseMemoryIdFromChunkId('mem-id#config')).toBe('mem-id#config');
    expect(baseMemoryIdFromChunkId('mem-id#c-not-a-number')).toBe('mem-id#c-not-a-number');
  });
});
