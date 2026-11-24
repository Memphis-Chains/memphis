/**
 * Project the bridge's export vocabulary from the Rust core into the
 * TypeScript mirror, and check that the two agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * The N-API bridge's vocabulary was declared in THREE places and compared by
 * nobody:
 *
 *   1. a hand-written list inside `bridge_manifest()` in the Rust crate;
 *   2. a hand-written alias map in TypeScript
 *      (`src/infra/storage/rust-bridge-manifest.ts`);
 *   3. the built binary — which is what the runtime actually calls.
 *
 * Measured 2026-11-23 on the operator's host, by reading the built module:
 * the binary exports **37** functions. The manifest named **34** — it
 * omitted `embed_index_metadata`, `embed_clear_in_memory` and
 * `embed_discard_replacement`, and it named nine of the rest with a
 * spelling the bridge never exports (`paths_resolve_data_dir` where the
 * bridge exports `pathsResolveDataDir`). The TypeScript map could not name
 * the three missing ones at all, and **34 of its 68 spellings never
 * matched** any export.
 *
 * THE HOUSE PATTERN
 * -----------------
 * The Rust core owns the vocabulary (`crates/memphis-napi/src/bridge_exports.rs`
 * — ONE table). This script copies that table into:
 *
 *   - `tests/fixtures/bridge-export-contract.json` — the artefact, and
 *   - `src/infra/storage/bridge-exports.generated.ts` — the TypeScript
 *     mirror, which is therefore a PROJECTION and not a second hand-written
 *     copy.
 *
 * Both sides check themselves against the artefact: the Rust arm in
 * `crates/memphis-napi/tests/bridge_export_contract.rs`, the TypeScript arm
 * in `tests/unit/bridge-export-contract.test.ts`. Neither produces it alone,
 * so neither can change it alone.
 *
 * THE BINARY IS THE THIRD WITNESS
 * -------------------------------
 * The script reads the vocabulary from the Rust core (through the manifest)
 * AND from the built module's own export keys, and refuses to project when
 * they disagree. A manifest that lies about its own crate cannot be
 * projected into a mirror that would inherit the lie.
 *
 * Write: npm run -s ops:sync-bridge-export-contract
 * Check: npm run -s ops:sync-bridge-export-contract -- --check  (exit 1 on drift)
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveRustBridgePath } from '../src/infra/runtime/install-root.js';
import type {
  BridgeExportBindingPayload,
  BridgeManifestPayload,
} from '../src/infra/storage/bridge-payloads.generated.js';

const FIXTURE = 'tests/fixtures/bridge-export-contract.json';
const MIRROR = 'src/infra/storage/bridge-exports.generated.ts';

/**
 * The manifest's shape is NOT written here.
 *
 * It used to be — a hand-written `Binding` and a hand-written
 * `ManifestEnvelope` beside the reader, which is how the two sides of the
 * manifest drifted: the TypeScript side marked `exportBindings` and
 * `optionalExports` OPTIONAL while the wire always sends them, and it
 * never read either. The shape now comes from the payload owner
 * (`crates/memphis-napi/src/bridge_payloads.rs`), projected into
 * `src/infra/storage/bridge-payloads.generated.ts`.
 *
 * `exportBindings` is optional THERE on purpose: a binary older than the
 * vocabulary table does not send it, and this projection fails loudly
 * when it is missing.
 */
type Binding = BridgeExportBindingPayload;

type ManifestEnvelope = {
  ok?: boolean;
  data?: BridgeManifestPayload;
  error?: string;
};

type BridgeModule = Record<string, unknown>;

/** The spelling napi-rs uses when no explicit `js_name` is given. */
function camelCase(name: string): string {
  const [first, ...rest] = name.split('_');
  return (
    first +
    rest
      .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
      .join('')
  );
}

function loadBridge(): { bridge: BridgeModule; path: string } {
  const path = resolveRustBridgePath(process.env);
  if (!existsSync(path)) {
    throw new Error(
      `the native bridge is missing at ${path} — build it first (npm run build:rust:release)`,
    );
  }
  const require = createRequire(`${process.cwd()}/`);
  const bridge = require(path) as BridgeModule;
  return { bridge, path };
}

function readVocabulary(): {
  bindings: Binding[];
  realExports: string[];
  bridgePath: string;
  problems: string[];
} {
  const { bridge, path } = loadBridge();
  const problems: string[] = [];

  const manifestFn = bridge.bridge_manifest;
  if (typeof manifestFn !== 'function') {
    throw new Error('the bridge does not export bridge_manifest');
  }
  const envelope = JSON.parse(String(manifestFn())) as ManifestEnvelope;
  if (!envelope.ok || !envelope.data) {
    throw new Error(`bridge_manifest failed: ${envelope.error ?? 'unknown error'}`);
  }

  const bindings = envelope.data.exportBindings ?? [];
  if (bindings.length === 0) {
    throw new Error(
      'the manifest carries no exportBindings — the Rust core predates the vocabulary table',
    );
  }

  const realExports = Object.keys(bridge)
    .filter((key) => typeof bridge[key] === 'function')
    .sort();

  // The manifest must describe the module that is actually loaded.
  const declared = new Set(bindings.map((binding) => binding.jsName));
  for (const name of realExports) {
    if (!declared.has(name)) {
      problems.push(
        `the bridge exports ${name}, but the manifest does not declare it — the Rust table is stale`,
      );
    }
  }
  for (const binding of bindings) {
    if (typeof bridge[binding.jsName] !== 'function') {
      problems.push(
        `the manifest declares ${binding.jsName}, but the bridge does not export it — the Rust table is stale`,
      );
    }
  }

  return { bindings, realExports, bridgePath: path, problems };
}

function buildFixture(bindings: Binding[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedBy: 'scripts/sync-bridge-export-contract.mts',
      owner: 'crates/memphis-napi/src/bridge_exports.rs',
      exports: bindings,
    },
    null,
    2,
  )}\n`;
}

function buildMirror(bindings: Binding[]): string {
  const entries = bindings
    .map((binding) => {
      const alternate =
        binding.jsName === binding.canonical
          ? camelCase(binding.canonical)
          : binding.canonical;
      return `  ${binding.canonical}: ['${binding.jsName}', '${alternate}'],`;
    })
    .join('\n');

  return `/**
 * The bridge's export vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust core's table
 * (\`crates/memphis-napi/src/bridge_exports.rs\`) by
 * \`scripts/sync-bridge-export-contract.mts\`. Regenerate with:
 *
 * \`\`\`bash
 * npm run -s ops:sync-bridge-export-contract
 * \`\`\`
 *
 * Each entry is the CANONICAL name (the Rust function) and the spellings the
 * bridge may export it under: the name napi-rs exports today, and the
 * spelling it would use under the other convention. The first spelling is
 * the one the binary really has — the gate proves that against the built
 * module, not against a comment.
 */
import type { BridgeAliasMap } from './napi-contract.js';

export const BRIDGE_EXPORT_ALIASES = {
${entries}
} as const satisfies BridgeAliasMap<string>;

export type RustBridgeManifestExport = keyof typeof BRIDGE_EXPORT_ALIASES;

export const DEFAULT_REQUIRED_RUST_BRIDGE_EXPORTS = [
${bindings
  .filter((binding) => binding.required)
  .map((binding) => `  '${binding.canonical}',`)
  .join('\n')}
] as const satisfies readonly RustBridgeManifestExport[];
`;
}

function main(): number {
  const check = process.argv.includes('--check');
  const { bindings, bridgePath, problems } = readVocabulary();

  if (problems.length > 0) {
    console.error('bridge export contract FAILED\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('');
    console.error(`  bridge: ${bridgePath}`);
    return 1;
  }

  const fixture = buildFixture(bindings);
  const mirror = buildMirror(bindings);

  if (check) {
    const problemsFound: string[] = [];
    for (const [label, path, expected] of [
      ['fixture', FIXTURE, fixture],
      ['mirror', MIRROR, mirror],
    ] as const) {
      if (!existsSync(path)) {
        problemsFound.push(`${label} ${path} does not exist`);
        continue;
      }
      if (readFileSync(path, 'utf8') !== expected) {
        problemsFound.push(`${label} ${path} is stale`);
      }
    }
    if (problemsFound.length > 0) {
      console.error('bridge export contract gate FAILED\n');
      for (const problem of problemsFound) console.error(`  ${problem}`);
      console.error('');
      console.error('  Run: npm run -s ops:sync-bridge-export-contract');
      return 1;
    }
    console.log(
      `[bridge-export-contract] OK (${bindings.length} exports, mirror in sync with the Rust core)`,
    );
    return 0;
  }

  mkdirSync(dirname(resolve(FIXTURE)), { recursive: true });
  writeFileSync(FIXTURE, fixture, 'utf8');
  writeFileSync(MIRROR, mirror, 'utf8');
  console.log(
    `[bridge-export-contract] wrote ${FIXTURE} and ${MIRROR} (${bindings.length} exports)`,
  );
  return 0;
}

process.exit(main());
