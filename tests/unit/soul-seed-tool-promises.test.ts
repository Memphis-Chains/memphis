/**
 * Invariant: soul-seed:capabilities entry must NOT promise tools that
 * aren't actually registered in TOOL_REGISTRY.
 *
 * Backstory (2026-05-12): Coder B's read-pass on PR #589 surface
 * caught that `src/soul/seed.ts:194` claimed Memphis has
 * `memphis_schedule_create`, `memphis_schedule_list`,
 * `memphis_schedule_cancel`, and the further audit here surfaced
 * SEVEN OTHER names that were never registered:
 *
 *   memphis_embed_store, memphis_embed_search, memphis_vault_get,
 *   memphis_vault_list, memphis_send, memphis_system_info,
 *   memphis_chain_query, memphis_providers
 *
 * The LLM sees these names in soul context, attempts a call, sees
 * "unknown tool", then either retries with a typo-like rejection or
 * fabricates a success result — feeding persistence-class confab
 * events. The fix anchors on `memphis_self_describe` instead of a
 * hardcoded list (the seed entry update in this same PR).
 *
 * This test pins the invariant going forward: every `memphis_*`
 * identifier mentioned in the seed entry body MUST appear in
 * TOOL_REGISTRY (or be the `memphis_self_describe` anchor we now
 * direct the LLM at).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const SEED_PATH = resolve(__dirname, '../../src/soul/seed.ts');

describe('soul-seed tool-name invariant', () => {
  it('every memphis_* identifier in soul-seed:capabilities exists in TOOL_REGISTRY', () => {
    const src = readFileSync(SEED_PATH, 'utf8');

    // Extract the soul-seed:capabilities block content. The block is
    // a single object literal with `source: 'soul-seed:capabilities'`
    // — pull the lines between that marker and the closing `},`.
    const startMarker = "source: 'soul-seed:capabilities'";
    const startIdx = src.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    // Walk forward until we find the next `},` at top-of-entry depth
    // — keep it simple: take the next 80 lines after the marker.
    const block = src.slice(startIdx, startIdx + 4000);

    // Find every `memphis_<word>` token in the block.
    const matches = block.match(/memphis_[a-z_]+/g) ?? [];
    const unique = Array.from(new Set(matches));
    expect(unique.length).toBeGreaterThan(0);

    const registryNames = new Set(Object.keys(TOOL_REGISTRY));

    const missing = unique.filter((name) => !registryNames.has(name));
    expect(
      missing,
      `soul-seed:capabilities references tool names that are not registered: ` +
        `${missing.join(', ')}. Either register them in TOOL_REGISTRY or remove ` +
        `from the seed block. The seed entry now anchors on memphis_self_describe ` +
        `as the authoritative source; do not bake hardcoded names back in.`,
    ).toEqual([]);
  });

  it('soul-seed:capabilities directs the LLM at memphis_self_describe', () => {
    // The anchor — if this assertion fails, the seed entry was
    // rewritten in a way that loses the "don't memorize tool names"
    // directive, which is the only sustainable way to keep the seed
    // stable across tool churn.
    const src = readFileSync(SEED_PATH, 'utf8');
    const startMarker = "source: 'soul-seed:capabilities'";
    const startIdx = src.indexOf(startMarker);
    const block = src.slice(startIdx, startIdx + 4000);
    expect(block).toContain('memphis_self_describe');
  });
});
