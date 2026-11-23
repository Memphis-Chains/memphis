/**
 * The panic-safety rule at the FFI boundary.
 *
 * ## Why this is a rule and not a style
 *
 * A Rust panic that unwinds across the N-API boundary reaches an
 * `extern "C"` symbol, and there Rust calls `abort()`. The process
 * dies. A JavaScript `try`/`catch` cannot intercept it — the caller
 * never gets an exception, because there is no longer a process to
 * throw into.
 *
 * Measured 2026-09-22 (docs/design/MEMPHIS-CRASH-REBUILD.md §2.2): 36
 * of the 37 exports of `crates/memphis-napi` were declared `#[napi]`
 * without `catch_unwind`. Exactly one had a hand-written guard, because
 * somebody had already been bitten by it.
 *
 * `napi-rs` emits the `std::panic::catch_unwind` wrapper only when the
 * attribute asks for it. So the protection is one word in the attribute:
 *
 *     #[napi(catch_unwind, js_name = "chain_append")]
 *
 * Every export carries it today, and until this module existed NOTHING
 * CHECKED. A convention is a rule with no gate, which is the shape this
 * repository keeps failing in.
 *
 * ## What it measures
 *
 * It reads the bridge source and names the exports that can abort the
 * process. It is a source check, not a runtime probe: the panic does not
 * have to happen for the export to be unprotected.
 */

/**
 * The exports in a bridge source that are NOT panic-proof.
 *
 * An export is protected when its `#[napi(...)]` attribute carries
 * `catch_unwind`. The attribute may be written on one line or spread
 * over several, so the parentheses are balanced before the attribute
 * body is read.
 */
export function findUnprotectedExports(source: string): string[] {
  const unprotected: string[] = [];
  const attributePattern = /#\[napi\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      const ch = source[end]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const attribute = source.slice(open, end + 1);
    // The attribute is closed by `]` AFTER the parenthesis, so the export
    // name is the first `pub fn` after it — not the text right after `)`.
    // Anchoring on the wrong boundary finds NOTHING and makes the rule
    // pass on every export.
    const fnMatch = /pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/.exec(source.slice(end + 1));
    if (!fnMatch) continue;
    if (!attribute.includes('catch_unwind')) {
      unprotected.push(fnMatch[1]!);
    }
  }

  return unprotected;
}

/** The exports in a bridge source, protected or not. */
export function listExports(source: string): string[] {
  const exports: string[] = [];
  const attributePattern = /#\[napi\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source)) !== null) {
    const open = source.indexOf('(', match.index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      const ch = source[end]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const fnMatch = /pub\s+(?:async\s+)?fn\s+([A-Za-z0-9_]+)/.exec(source.slice(end + 1));
    if (fnMatch) exports.push(fnMatch[1]!);
  }

  return exports;
}
