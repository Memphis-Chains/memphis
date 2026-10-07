/**
 * Regenerate the native tool tier table in crates/memphis-operator/src/chat.rs
 * from the TypeScript registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tool_tier` in crates/memphis-operator/src/chat.rs and `TOOL_REGISTRY` in
 * src/gateway/tool-registry.ts were two independent sources of truth for the
 * same question: how much authorization does this tool need. Nothing
 * compared them, so they drifted. Measured 2026-10-07, five tools were one
 * tier lower natively than in the registry — `memphis_code_read`,
 * `memphis_grep`, `memphis_glob`, `memphis_git`, `memphis_web_fetch`. On a
 * surface pinned to MEMPHIS_OPERATOR_MAX_TOOL_TIER=1 (the Telegram baseline)
 * the gateway refused `memphis_code_read` while the native operator returned
 * the file body; a test printed README.md contents through
 * `execute_native_tool(..., 1)` to prove it.
 *
 * The registry is the authority: the MCP server, the JSON-schema exporter and
 * the confabulation detector all read it. This script projects it into the
 * one place the native surface can consult without a Node process.
 *
 * Run: `npm run -s ops:sync-native-tiers`
 * Check: `npm run -s ops:sync-native-tiers -- --check` (exit 1 on drift, for CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TOOL_REGISTRY } from '../src/gateway/tool-registry.js';

const TARGET = resolve('crates/memphis-operator/src/chat.rs');

/**
 * Tools the native operator actually exposes.
 *
 * Kept explicit rather than derived from the registry: the native surface is
 * a strict subset, and a registry tool with no native arm is not a tier
 * conflict — it simply cannot be called there. When a tool is added to the
 * native surface, add it here too, or it will silently get tier 0.
 */
const NATIVE_TOOLS = [
  'memphis_exec',
  'memphis_self_modify',
  'memphis_test',
  'memphis_cron',
  'memphis_classify',
  'memphis_code_read',
  'memphis_web_fetch',
  'memphis_grep',
  'memphis_glob',
  'memphis_git',
] as const;

const FN_MARKER = 'fn tool_tier(name: &str) -> u8 {';

function render(): string {
  const registry = TOOL_REGISTRY as Record<string, { tier?: number }>;

  const byTier = new Map<number, string[]>();
  for (const name of NATIVE_TOOLS) {
    const tier = registry[name]?.tier ?? 0;
    if (!byTier.has(tier)) byTier.set(tier, []);
    byTier.get(tier)!.push(name);
  }

  const arms = [...byTier.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([tier, names]) => {
      const list = names.map((n) => `"${n}"`).join('\n        | ');
      return `        ${list} => ${tier},`;
    })
    .join('\n');

  return `/// Tier for every tool the native surface exposes.
///
/// GENERATED — do not edit by hand. Source of truth is
/// src/gateway/tool-registry.ts (\`TOOL_REGISTRY\`), which the MCP server,
/// the JSON-schema exporter and the confabulation detector all read.
///
/// Regenerate with \`npm run -s ops:sync-native-tiers\`, and check drift with
/// \`npm run -s ops:sync-native-tiers -- --check\` (exit 1 when out of sync).
///
/// These two used to disagree, and nothing compared them:
/// \`memphis_code_read\` was tier 2 in TypeScript and tier 1 here, so a
/// surface pinned to tier 1 had the gateway refuse the call while the native
/// operator served the file body. \`memphis_grep\`, \`memphis_glob\`,
/// \`memphis_git\` and \`memphis_web_fetch\` were also one tier lower natively.
///
/// A tool not listed here is tier 0 — no authorization required. The native
/// surface exposes only the ${NATIVE_TOOLS.length} above; anything else never
/// reaches this match.
${FN_MARKER}
    match name {
${arms}
        _ => 0,
    }
}`;
}

/** Line index of the first line of the `tool_tier` fn, or its doc comment. */
function findFnStart(lines: string[]): number {
  const idx = lines.findIndex((l) => l.startsWith(FN_MARKER));
  if (idx === -1) throw new Error(`${FN_MARKER} not found in ${TARGET}`);

  let start = idx;
  // Walk back over the contiguous run of `///` lines directly above.
  while (start > 0 && lines[start - 1].startsWith('///')) start--;
  return start;
}

function splice(src: string, body: string): string {
  const lines = src.split('\n');
  const from = findFnStart(lines);

  // The fn ends at the first line that is exactly `}` after its opening.
  let end = -1;
  for (let i = from; i < lines.length; i++) {
    if (lines[i] === '}') {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error(`unterminated tool_tier in ${TARGET}`);

  return [...lines.slice(0, from), ...body.split('\n'), ...lines.slice(end + 1)].join('\n');
}

const current = readFileSync(TARGET, 'utf8');
const next = splice(current, render());

if (next === current) {
  console.log('[sync-native-tiers] up to date');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error('[sync-native-tiers] drift: tool_tier is out of sync with TOOL_REGISTRY');
  console.error('[sync-native-tiers] run: npm run -s ops:sync-native-tiers');
  process.exit(1);
}

writeFileSync(TARGET, next, 'utf8');
console.log('[sync-native-tiers] regenerated tool_tier from TOOL_REGISTRY');
