/**
 * The FFI panic-safety rule — the one that cannot be caught from
 * JavaScript.
 *
 * ## Why
 *
 * A Rust panic that unwinds across the N-API boundary reaches an
 * `extern "C"` symbol, and there Rust calls `abort()`. The process
 * dies. The TypeScript caller never gets an exception, because there is
 * no longer a process to throw into.
 *
 * Measured 2026-09-22 (docs/design/MEMPHIS-CRASH-REBUILD.md §2.2): 36
 * of the 37 exports of `crates/memphis-napi` were declared `#[napi]`
 * without `catch_unwind`. One had a hand-written guard, because
 * somebody had already been bitten by it.
 *
 * The protection is one word in the attribute — `catch_unwind` — and
 * until this rule existed, every export carried it and NOTHING CHECKED.
 *
 * ## What this test measures
 *
 * The rule reads the bridge source. The test feeds it sources, so the
 * failure is reachable without touching the real bridge: an export
 * without the guard is named, and the real bridge has none.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  findUnprotectedExports,
  listExports,
} from '../../scripts/lib/napi-panic-safety.mts';

const BRIDGE_SOURCE = resolve('crates/memphis-napi/src/lib.rs');

describe('the FFI panic-safety rule', () => {
  it('names the export that can abort the process', () => {
    const source = `
#[napi(js_name = "chain_append")]
pub fn chain_append(block_json: String) -> String {
    String::new()
}
`;
    expect(findUnprotectedExports(source)).toEqual(['chain_append']);
  });

  it('accepts an export that asks for the guard', () => {
    const source = `
#[napi(catch_unwind, js_name = "chain_append")]
pub fn chain_append(block_json: String) -> String {
    String::new()
}
`;
    expect(findUnprotectedExports(source)).toEqual([]);
  });

  it('reads an attribute spread over several lines', () => {
    const source = `
#[napi(
    catch_unwind,
    js_name = "chain_validate"
)]
pub fn chain_validate(block_json: String) -> String {
    String::new()
}
`;
    expect(findUnprotectedExports(source)).toEqual([]);
  });

  it('sees every export of the real bridge, and every one is protected', () => {
    // The real gate is `npm run -s ops:check-native-bridge`. This
    // assertion is the same rule stated as a test, so the failure is
    // reachable in the suite without rebuilding the Rust binary.
    const source = readFileSync(BRIDGE_SOURCE, 'utf8');
    const exports = listExports(source);

    expect(exports.length).toBeGreaterThan(0);
    expect(findUnprotectedExports(source)).toEqual([]);
  });
});
