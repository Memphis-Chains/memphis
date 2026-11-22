/**
 * Reads the native (Rust) tool catalog from the Rust source.
 *
 * ## Why this is a shared rule and not a helper in one place
 *
 * Three callers need to know WHICH TOOLS the native surface advertises:
 * the tier generator (`scripts/sync-native-tiers.mts`), the contract
 * generator (`scripts/sync-native-tool-contract.mts`) and the contract
 * tests. Before ADR-012 they each grepped the Rust source on their own,
 * with their own regular expression — and when the catalog changed shape
 * the greps went quiet instead of loud: `sync-native-tiers -- --check`
 * failed with "Native catalog and executable tool arms differ" for a
 * reason nobody could see, because the names had simply moved.
 *
 * A grep that fails SILENTLY is worse than no gate. So the rule lives
 * here, once, and the gate says what it read.
 *
 * ## What the native catalog is, since ADR-012 (2026-11-22)
 *
 * Two parts, and the difference between them is the point:
 *
 *   1. `crates/memphis-operator/src/chat_tool_contract.rs` — the
 *      PROJECTION generated from `TOOL_REGISTRY`. It carries the contract
 *      as JSON verbatim, so the names are read out of that JSON rather
 *      than guessed with a regular expression.
 *   2. `crates/memphis-operator/src/chat_tool_catalog.rs` — the DIVERGENT
 *      tools, whose native implementation does not (yet) honour the
 *      registry, so they keep a hand-written schema that says what the
 *      native surface actually accepts.
 *
 * ## The rule this module enforces
 *
 * The catalog file may hand-write a schema ONLY for a tool the contract
 * declares as divergent. Every other name in that file is a second copy
 * of the registry that nothing compares — the failure mode ADR-012 was
 * written to remove.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RUST_CONTRACT_PATH = 'crates/memphis-operator/src/chat_tool_contract.rs';
export const RUST_CATALOG_PATH = 'crates/memphis-operator/src/chat_tool_catalog.rs';

const HAND_WRITTEN_NAME = /name: "(memphis_[a-z0-9_]+)"/g;

export interface NativeCatalog {
  /** Tool names the projection carries (the registry's schemas). */
  projected: string[];
  /** Tool names the contract declares as divergent. */
  declaredDivergent: string[];
  /** Every tool name hand-written in the catalog file. */
  handWritten: string[];
  /** Every tool the native surface advertises. */
  advertised: string[];
  /** Hand-written names the contract does not declare as divergent — must be empty. */
  stray: string[];
}

/** The JSON contract embedded in the generated Rust file. */
function readProjectedContract(): { tools: string[]; divergences: string[] } {
  const source = readFileSync(resolve(RUST_CONTRACT_PATH), 'utf8');
  const start = source.indexOf('r#"');
  const end = source.indexOf('"#;', start);
  if (start < 0 || end < 0) {
    throw new Error('the generated native tool contract has no JSON payload');
  }
  const document = JSON.parse(source.slice(start + 3, end)) as {
    tools?: Array<{ name?: string }>;
    divergences?: Array<{ name?: string }>;
  };
  const names = (entries: Array<{ name?: string }> | undefined): string[] =>
    (entries ?? [])
      .map((entry) => entry.name)
      .filter((name): name is string => typeof name === 'string');
  return {
    tools: names(document.tools),
    divergences: names(document.divergences),
  };
}

/** Every tool name the catalog file writes by hand. */
function readHandWrittenNames(): string[] {
  const source = readFileSync(resolve(RUST_CATALOG_PATH), 'utf8');
  return [...source.matchAll(HAND_WRITTEN_NAME)].map((match) => match[1]);
}

export function readNativeCatalog(): NativeCatalog {
  const projection = readProjectedContract();
  const handWritten = readHandWrittenNames();

  return {
    projected: projection.tools,
    declaredDivergent: projection.divergences,
    handWritten,
    advertised: [...projection.tools, ...handWritten],
    stray: handWritten.filter((name) => !projection.divergences.includes(name)),
  };
}

/** The tool names the native surface advertises. */
export function readNativeAdvertisedToolNames(): string[] {
  return readNativeCatalog().advertised;
}

/**
 * The tool names the native dispatcher can actually run, read from the
 * match arms in `execute_native_tool`.
 *
 * The dispatcher is still hand-written — it is Rust code that performs
 * the work — so its arms are the ground truth for "what runs", and the
 * advertised set must not exceed it.
 */
export function readNativeExecutableToolNames(): string[] {
  const source = readFileSync(resolve('crates/memphis-operator/src/chat_tool_executor.rs'), 'utf8');
  const executor = source.split('fn execute_native_tool(')[1];
  if (!executor) {
    throw new Error('Rust executor boundary not found: execute_native_tool(');
  }
  return [...executor.matchAll(/^ {8}"(memphis_[a-z0-9_]+)" =>/gm)].map((match) => match[1]);
}
