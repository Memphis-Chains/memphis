/**
 * Regenerate the native tool tier table in
 * crates/memphis-operator/src/chat_tool_catalog.rs from the TypeScript registry.
 *
 * WHY THIS EXISTS
 * ---------------
 * `tool_tier` in crates/memphis-operator/src/chat_tool_catalog.rs and
 * `TOOL_REGISTRY` in src/gateway/tool-registry.ts were two independent sources of truth for the
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

import { requireToolPolicy } from '../src/gateway/native-tool-policy.js';
import { NATIVE_TOOL_CONTRACTS, nativeToolContractNames } from '../src/gateway/tool-contract.js';
import { TOOL_REGISTRY } from '../src/gateway/tool-registry.js';

// The catalog and the dispatcher live in separate modules since the
// `chat.rs` split (2026-10-22). The tier table itself is generated into the
// catalog module, next to the advertised tool list it gates.
const TARGET = resolve('crates/memphis-operator/src/chat_tool_catalog.rs');
const EXECUTOR_TARGET = resolve('crates/memphis-operator/src/chat_tool_executor.rs');

// Catalog and dispatcher must agree. Discover actual native operations so a new
// executable arm cannot accidentally inherit tier zero.
const source = readFileSync(TARGET, 'utf8');
const executorSource = readFileSync(EXECUTOR_TARGET, 'utf8');
const catalog = source.split('fn native_tool_definitions()')[1]?.split('fn tool_tier(')[0];
const executor = executorSource.split('fn execute_native_tool(')[1];
if (!catalog || !executor) throw new Error('Native catalog/dispatcher boundaries missing');
const advertised = [...catalog.matchAll(/name: "(memphis_[a-z0-9_]+)"/g)].map((m) => m[1]);
const executable = [...executor.matchAll(/^ {8}"(memphis_[a-z0-9_]+)" =>/gm)].map((m) => m[1]);
if (JSON.stringify([...advertised].sort()) !== JSON.stringify([...executable].sort())) {
  throw new Error('Native catalog and executable tool arms differ');
}
const NATIVE_TOOLS = [...new Set(executable)].sort();

// The shared contract must describe exactly the tools the native surface
// executes. A tool that is executable but absent from the contract has no
// single source of truth for its tier — that is exactly the drift this
// check exists to catch.
const CONTRACT_TOOLS = [...nativeToolContractNames()].sort();
if (JSON.stringify(NATIVE_TOOLS) !== JSON.stringify(CONTRACT_TOOLS)) {
  const missingFromContract = NATIVE_TOOLS.filter((n) => !CONTRACT_TOOLS.includes(n));
  const missingFromNative = CONTRACT_TOOLS.filter((n) => !NATIVE_TOOLS.includes(n));
  throw new Error(
    [
      'Native tool contract and the native surface disagree.',
      missingFromContract.length
        ? `  executable but not in the contract: ${missingFromContract.join(', ')}`
        : '',
      missingFromNative.length
        ? `  in the contract but not executable: ${missingFromNative.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

// Every contract entry must also agree with the TypeScript registry on the
// tier, so the two surfaces cannot drift apart on authorization level.
for (const contract of NATIVE_TOOL_CONTRACTS) {
  const registryMeta = TOOL_REGISTRY[contract.name];
  if (!registryMeta) {
    if (contract.gatewayHidden) {
      // Native-only by design: the gateway does not advertise it.
      continue;
    }
    throw new Error(
      `Tool ${contract.name} is executable natively and not gateway-hidden, but absent from TOOL_REGISTRY`,
    );
  }
  if (registryMeta.tier !== contract.tier) {
    throw new Error(
      `Tier drift for ${contract.name}: contract says ${contract.tier}, TOOL_REGISTRY says ${registryMeta.tier}`,
    );
  }
}

const FN_MARKER = 'pub(crate) fn tool_tier(name: &str) -> u8 {';

function render(): string {
  const byTier = new Map<number, string[]>();
  for (const name of NATIVE_TOOLS) {
    const tier = requireToolPolicy(name, TOOL_REGISTRY).tier;
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
/// Covers all ${NATIVE_TOOLS.length} catalog and dispatcher operations. Unknown tools
/// are denied; adding a tool without explicit policy fails generation.
${FN_MARKER}
    match name {
${arms}
        _ => u8::MAX,
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
