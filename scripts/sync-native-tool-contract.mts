/**
 * Project the native tool contract from the TypeScript registry into the
 * Rust cockpit, and check that the two agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The registry (`src/gateway/tool-registry.ts`) is the authority on what a
 * tool accepts. The native cockpit advertised its own copy of the same
 * contract, hand-written in Rust, and nothing compared the two.
 *
 * Measured 2026-11-22 on this host, the drift was real and it was not
 * cosmetic. Five of the 23 native tools advertised DIFFERENT ARGUMENTS
 * from the registry:
 *
 *   - `memphis_git` — the catalog required `command`; the executor and the
 *     registry both use `subcommand`. The catalog was lying about the
 *     tool it sat next to.
 *   - `memphis_journal` — the catalog had no `chain`; the registry has it.
 *   - `memphis_exec` — the catalog had no `surface_intent`.
 *   - `memphis_chain_query` — the catalog had no `offset`/`blockType`.
 *   - `memphis_self_modify` — the catalog advertised `{path, content,
 *     mode}`; the registry advertises `{intent, files, changes, plan_id,
 *     step_idx}`. These are not two schemas for one tool: they are two
 *     different tools wearing one name. The native one writes a single
 *     file; the TypeScript one applies a set of changes to a set of files.
 *   - `memphis_case_append` — the catalog advertised `{entry}`, the
 *     registry the flat case fields.
 *
 * A model talking to the cockpit and a model talking to Telegram, the CLI
 * or MCP were therefore offered different tools under the same names.
 *
 * THE HOUSE PATTERN, TWICE
 * ------------------------
 * `scripts/sync-native-tiers.mts` already projects the registry's TIERS
 * into the Rust catalog and fails the build on drift. This does the same
 * for the contract itself: the registry is projected into ONE JSON
 * artifact, the Rust side reads that artifact, and BOTH sides check
 * themselves against it.
 *
 * The artifact is JSON because the reference architecture says so: Rust
 * owns the data plane, N-API is the only bridge, and JSON is the only
 * format. A hand-written Rust literal is a second copy; a generated JSON
 * constant is a projection.
 *
 *   tests/fixtures/native-tool-contract.json   ← the agreed contract
 *   crates/memphis-operator/src/chat_tool_contract.rs  ← its projection
 *
 * The Rust side has its own check (a unit test in the operator crate), the
 * TypeScript side has its own (`tests/unit/native-tool-contract.test.ts`),
 * and this script is the gate that says the two are still the same file.
 *
 * Run:    npm run -s ops:sync-native-tool-contract
 * Check:  npm run -s ops:sync-native-tool-contract -- --check  (exit 1 on drift)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { nativeToolContractNames } from '../src/gateway/tool-contract.js';
import { buildRegistryInputJsonSchema } from '../src/gateway/tool-json-schema.js';
import { TOOL_REGISTRY } from '../src/gateway/tool-registry.js';

const REPO_ROOT = resolve('.');
const FIXTURE = resolve(REPO_ROOT, 'tests/fixtures/native-tool-contract.json');
const RUST_TARGET = resolve(REPO_ROOT, 'crates/memphis-operator/src/chat_tool_contract.rs');

/**
 * The contract of one tool: what it is called, what it accepts, what it
 * says about itself.
 *
 * The input schema is the registry's own rendering. The transport key
 * `approval_request_id` is dropped — it is how the gateway asks for
 * approval, not an argument the tool takes.
 */
type ToolContract = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

/**
 * The tools whose native implementation does NOT honour the registry.
 *
 * Measured 2026-11-22: five of the 23 native tools advertised different
 * arguments than the registry does, and for these the EXECUTOR is behind
 * the registry — not just the schema. The native surface keeps a schema
 * that says what it actually accepts, and the difference is declared in
 * the artifact so it is visible, owned and measurable.
 *
 * A schema that promises what the surface cannot execute is the same
 * class of bug as a schema that promises the wrong argument names.
 */
const DIVERGENCES: Record<string, { reason: string; closure: string }> = {
  memphis_self_modify: {
    reason:
      'under one name the registry means "apply changes to many files, with a snapshot and a test run"; the native tool writes ONE file. Same name, two different operations.',
    closure:
      'implement the registry semantics natively, or rename the native operation so the name stops lying',
  },
};

/**
 * The prose the native surface teaches the model.
 *
 * A DESCRIPTION is presentation, not contract: the gateway keeps its
 * property descriptions at the call site, and the cockpit keeps its own
 * here. The contract — names, types, constraints, required — is the
 * registry's, projected.
 *
 * This table is the cockpit's half of that split. It was extracted from
 * the hand-written schemas the projection replaced, so nothing is lost:
 * the guidance the model was taught on the cockpit is still taught.
 */
const GUIDANCE_PATH = resolve(
  REPO_ROOT,
  'crates/memphis-operator/src/chat_tool_guidance.json',
);

type Guidance = Record<string, Record<string, string>>;

function readGuidance(): Guidance {
  if (!existsSync(GUIDANCE_PATH)) return {};
  return JSON.parse(readFileSync(GUIDANCE_PATH, 'utf8')) as Guidance;
}

/**
 * Render one registry entry the way the provider surface renders it.
 *
 * The cockpit talks to the same provider API as the gateway, so it must
 * be shown the same schema — `buildRegistryInputJsonSchema` is the
 * gateway's own renderer, used here rather than a second one.
 */
function renderContract(toolName: string, guidance: Guidance): ToolContract | null {
  const meta = (TOOL_REGISTRY as Record<string, { description?: string }>)[toolName];
  if (!meta) return null;

  let input_schema: Record<string, unknown>;
  try {
    input_schema = buildRegistryInputJsonSchema(toolName) as Record<string, unknown>;
  } catch {
    return null;
  }

  // The cockpit's own field descriptions are merged in. They never
  // override the registry's: the registry's text is the contract's text.
  const properties = { ...((input_schema.properties as Record<string, unknown>) ?? {}) };
  for (const [key, description] of Object.entries(guidance[toolName] ?? {})) {
    if (!properties[key] || typeof properties[key] !== 'object') continue;
    if ((properties[key] as Record<string, unknown>).description) continue;
    properties[key] = { ...(properties[key] as Record<string, unknown>), description };
  }
  input_schema.properties = properties;

  return {
    name: toolName,
    description: meta.description ?? '',
    input_schema,
  };
}

/**
 * The contract of every native tool, in a stable order.
 *
 * The order is the registry's order, so the artifact changes only when
 * the contract changes — not when a file is written twice.
 */
function buildContractDocument(): {
  schemaVersion: number;
  tools: ToolContract[];
  divergences: Array<{ name: string; reason: string; closure: string }>;
} {
  const guidance = readGuidance();
  const divergences = Object.entries(DIVERGENCES).map(([name, entry]) => ({
    name,
    reason: entry.reason,
    closure: entry.closure,
  }));
  const divergent = new Set(Object.keys(DIVERGENCES));

  const tools = nativeToolContractNames()
    .filter((name) => !divergent.has(name))
    .map((name) => renderContract(name, guidance))
    .filter((contract): contract is ToolContract => contract !== null);

  return { schemaVersion: 1, tools, divergences };
}

/** Canonical JSON: keys sorted, recursively, so the artifact is stable. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The Rust file: the same JSON, as a constant the cockpit parses. */
function renderRustSource(document: { schemaVersion: number; tools: ToolContract[] }): string {
  const json = JSON.stringify(document, null, 2);
  // `r#"..."#` ends at the first `"#`; the contract's JSON must not
  // contain that sequence. It cannot today (no key or value holds a
  // hash followed by a quote), but the guard is cheap and the failure
  // would be a compile error in a generated file.
  if (json.includes('"#')) {
    throw new Error('the contract JSON contains `"#` and cannot be embedded in a raw string');
  }

  return `//! The native tool contract, projected from the TypeScript registry.
//!
//! GENERATED FILE — do not edit by hand.
//!
//! Regenerate with: npm run -s ops:sync-native-tool-contract
//! Check with:     npm run -s ops:sync-native-tool-contract -- --check
//!
//! Why it is JSON and not Rust literals: the reference architecture says
//! JSON is the only format, and a hand-written schema is a second copy of
//! the registry. This file is a projection, checked against
//! tests/fixtures/native-tool-contract.json by the operator crate's own
//! test, and by tests/unit/native-tool-contract.test.ts on the TypeScript
//! side.
//!
//! Measured 2026-11-22: before this file existed the cockpit advertised
//! five tools with different arguments than the registry — including
//! \`memphis_self_modify\`, which under one name meant "write one file"
//! and under the other "apply changes to many files".

/// The contract of every tool the native surface offers.
pub(crate) const NATIVE_TOOL_CONTRACT_JSON: &str = r#"${json}"#;
`;
}

function main(): void {
  const check = process.argv.includes('--check');
  const document = buildContractDocument();
  const fixtureJson = `${JSON.stringify(document, null, 2)}\n`;
  const rustSource = renderRustSource(document);

  // `--check` is the gate: it compares and fails. Without it, the script
  // is the projection: it writes what the registry says.
  if (check) {
    const problems: string[] = [];

    const existingFixture = existsSync(FIXTURE) ? readFileSync(FIXTURE, 'utf8') : null;
    if (
      existingFixture === null ||
      canonicalJson(JSON.parse(existingFixture)) !== canonicalJson(document)
    ) {
      problems.push(
        'tests/fixtures/native-tool-contract.json does not match the registry — ' +
          'run: npm run -s ops:sync-native-tool-contract',
      );
    }

    const existingRust = existsSync(RUST_TARGET) ? readFileSync(RUST_TARGET, 'utf8') : null;
    if (existingRust === null || existingRust !== rustSource) {
      problems.push(
        'crates/memphis-operator/src/chat_tool_contract.rs does not match the registry — ' +
          'run: npm run -s ops:sync-native-tool-contract',
      );
    }

    if (problems.length > 0) {
      console.error('native tool contract gate FAILED\n');
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('');
      process.exit(1);
    }

    console.log(
      `native tool contract OK — ${document.tools.length} projected tool(s), ` +
        `${document.divergences.length} declared divergence(s)`,
    );
    return;
  }

  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, fixtureJson, 'utf8');
  writeFileSync(RUST_TARGET, rustSource, 'utf8');
  console.log(
    `projected ${document.tools.length} native tool contract(s) into ` +
      'tests/fixtures/native-tool-contract.json and crates/memphis-operator/src/chat_tool_contract.rs',
  );
}

main();
