/**
 * Does the native scanner cover every pattern the TypeScript one blocks?
 *
 * WHY THIS EXISTS
 * ---------------
 * The memory-profile scanner exists twice: `MEMORY_PATTERNS` in
 * src/security/content-scan.ts and `scan_memory_content` in
 * crates/memphis-operator/src/chat.rs. Measured 2026-10-07, the native copy
 * guarded 4 of 11 — so exfiltration-shaped content and SSH-persistence
 * content was refused by MCP/gateway and accepted by the TUI, which is the
 * surface that actually writes.
 *
 * The seven missing arms were added by hand, which fixed the instance but
 * not the class: nothing then connected the two lists, so adding a pattern
 * to TypeScript tomorrow would again leave the native path behind.
 *
 * This is the connection. It parses both files and fails when a pattern id
 * appears in one and not the other.
 *
 * It deliberately checks *ids*, not regexes. The regex dialects differ
 * (`(?iu)` prefixes, `\s` vs `[[:space:]]`), and a diff over source text
 * would report differences that are not behavioural. Behavioural parity is
 * pinned separately, on real inputs, by
 * `native_scanner_blocks_every_pattern_the_typescript_profile_blocks` in
 * crates/memphis-operator/src/chat.rs.
 *
 * Run: `npm run -s ops:check-scan-parity`
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TS_FILE = resolve('src/security/content-scan.ts');
const RUST_FILE = resolve('crates/memphis-operator/src/chat.rs');

function tsMemoryPatternIds(src: string): string[] {
  const block = src.match(/const MEMORY_PATTERNS: ThreatPattern\[\] = \[([\s\S]*?)\n\];/);
  if (!block) throw new Error('MEMORY_PATTERNS not found in content-scan.ts');
  return [...block[1].matchAll(/id: '([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * Native ids, from both arms: the private list in `scan_memory_content` and
 * the shared `secret_exfiltration_patterns()` the code-change profile also
 * uses. Reading only the private list would report five false gaps.
 */
function rustPatternIds(src: string): Set<string> {
  const ids = new Set<string>();

  const privateBlock = src.match(
    /fn scan_memory_content[\s\S]*?let patterns = \[([\s\S]*?)\n\s{4}\];/,
  );
  if (!privateBlock) throw new Error('scan_memory_content pattern list not found');
  for (const m of privateBlock[1].matchAll(/"([a-z_]+)",/g)) ids.add(m[1]);

  const sharedBlock = src.match(
    /fn secret_exfiltration_patterns[\s\S]*?\[\s*([\s\S]*?)\n\s{4}\]\s*\n\s{4}\.into_iter/,
  );
  if (!sharedBlock) throw new Error('secret_exfiltration_patterns list not found');
  for (const m of sharedBlock[1].matchAll(/"([a-z_]+)",/g)) ids.add(m[1]);

  return ids;
}

const tsIds = tsMemoryPatternIds(readFileSync(TS_FILE, 'utf8'));
const rustIds = rustPatternIds(readFileSync(RUST_FILE, 'utf8'));

const missing = tsIds.filter((id) => !rustIds.has(id));
const extra = [...rustIds].filter((id) => !tsIds.includes(id));

console.log(`[scan-parity] TypeScript memory profile: ${tsIds.length} patterns`);
console.log(`[scan-parity] Native scanner:            ${rustIds.size} patterns`);

if (missing.length > 0 || extra.length > 0) {
  if (missing.length > 0) {
    console.error(`[scan-parity] blocked in TypeScript, MISSING natively: ${missing.join(', ')}`);
    console.error(
      '[scan-parity] the native surface is the one that writes journal entries — add the arm there.',
    );
  }
  if (extra.length > 0) {
    console.error(
      `[scan-parity] present natively but not in the TypeScript profile: ${extra.join(', ')}`,
    );
  }
  process.exit(1);
}

console.log('[scan-parity] OK — same pattern ids in both layers');
