/**
 * Reads the native (Rust) tool catalog from the Rust source.
 *
 * WHY A HELPER
 * -------------
 * The contract tests run in TypeScript and the Rust binary is not built for
 * them, so the Rust side is read as text. Since ADR-012 (2026-11-22) the
 * native catalog has TWO parts, and a test that reads only one of them
 * agrees with itself and proves nothing:
 *
 *   1. `crates/memphis-operator/src/chat_tool_contract.rs` — the PROJECTION
 *      generated from `TOOL_REGISTRY`. It carries the contract as JSON
 *      verbatim, so the names are read out of that JSON rather than guessed
 *      with a regular expression.
 *   2. `crates/memphis-operator/src/chat_tool_catalog.rs` — the DIVERGENT
 *      tools, whose native implementation does not (yet) honour the
 *      registry, so they keep a hand-written schema that says what the
 *      native surface actually accepts.
 *
 * THE RULE THIS HELPER ENCODES
 * ----------------------------
 * The catalog file may hand-write a schema ONLY for a tool the contract
 * declares as divergent. Every other name in that file is a second copy of
 * the registry that nothing compares — the failure mode ADR-012 was
 * written to remove. So the check is not "are these two lists equal" but
 * "does every hand-written name appear on the declared divergence list".
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const RUST_CONTRACT = resolve('crates/memphis-operator/src/chat_tool_contract.rs');
const RUST_CATALOG = resolve('crates/memphis-operator/src/chat_tool_catalog.rs');

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
  const source = readFileSync(RUST_CONTRACT, 'utf8');
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
  const source = readFileSync(RUST_CATALOG, 'utf8');
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
