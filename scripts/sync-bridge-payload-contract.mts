/**
 * Project the bridge's payload shapes from the Rust core into the
 * TypeScript mirror, and check that the two agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * E-01 gave the bridge's export VOCABULARY one owner. This is the layer
 * under it: the SHAPE of what those exports carry.
 *
 * Measured 2026-11-24 on the operator's host, the shape was GUESSED in
 * seven TypeScript files:
 *
 *   - `rust-vault-adapter.ts` declared `entries_json?` AND `entriesJson?`,
 *     `error_code?` AND `errorCode?`, `master_key?` AND `masterKey?`, and
 *     read `result.entries_json ?? result.entriesJson` — the contract
 *     guessed, and the guess written down twice;
 *   - `rust-embed-adapter.ts` declared `RawEmbedStoreResult` by hand, with
 *     `normalized?: boolean | string` — on the wire `normalized` is a
 *     STRING, always.
 *
 * The guess was not laziness: the Rust owner speaks TWO spellings. A
 * `#[napi(object)]` struct without an explicit `#[napi(js_name = "...")]`
 * is exported in camelCase by napi-rs, so `JsEntriesResult` reaches
 * JavaScript as `entriesJson` / `errorCode`, while its sibling
 * `JsVaultStateResult` — which DOES carry an explicit `js_name` — reaches
 * JavaScript as `error_code`. One hand-written TypeScript interface had to
 * cover both, so it hedged.
 *
 * THE HOUSE PATTERN
 * -----------------
 * The Rust core owns the shapes (`crates/memphis-napi/src/bridge_payloads.rs`
 * — ONE table). This script copies that table into:
 *
 *   - `tests/fixtures/bridge-payload-contract.json` — the artefact, and
 *   - `src/infra/storage/bridge-payloads.generated.ts` — the TypeScript
 *     mirror, which is therefore a PROJECTION and not a second hand-written
 *     copy.
 *
 * Both sides check themselves against the artefact: the Rust arm in
 * `crates/memphis-napi/tests/bridge_payload_contract.rs`, the TypeScript arm
 * in `tests/unit/bridge-payload-contract.test.ts`. Neither produces it
 * alone, so neither can change it alone.
 *
 * THE BINARY IS THE WITNESS
 * -------------------------
 * The table is read from the BUILT module, through the bridge's own
 * `bridge_payload_manifest` export — and every export the table names must
 * really exist in that module. A table that describes a bridge that is not
 * there cannot be projected into a mirror that would inherit the lie.
 *
 * Write: npm run -s ops:sync-bridge-payload-contract
 * Check: npm run -s ops:sync-bridge-payload-contract -- --check  (exit 1 on drift)
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveRustBridgePath } from '../src/infra/runtime/install-root.js';

const FIXTURE = 'tests/fixtures/bridge-payload-contract.json';
const MIRROR = 'src/infra/storage/bridge-payloads.generated.ts';

type FieldType =
  | { kind: 'string' | 'number' | 'integer' | 'boolean' | 'bytes' | 'json' }
  | { kind: 'named'; name: string };

type PayloadField = {
  name: string;
  type: FieldType;
  optional: boolean;
  nullable: boolean;
  /** The spelling this field had in older binaries — declared, not guessed. */
  legacyName?: string | null;
};

type PayloadShape = {
  name: string;
  fields: PayloadField[];
};

type PayloadRow = {
  export: string;
  transport: 'envelopeJson' | 'nativeObject' | 'bytes';
  shape: string | null;
};

type ManifestEnvelope = {
  ok?: boolean;
  data?: {
    name?: string;
    schemaVersion?: number;
    owner?: string;
    shapes?: PayloadShape[];
    payloads?: PayloadRow[];
  };
  error?: string;
};

type BridgeModule = Record<string, unknown>;

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

function readManifest(): {
  shapes: PayloadShape[];
  payloads: PayloadRow[];
  bridgePath: string;
  problems: string[];
} {
  const { bridge, path } = loadBridge();
  const problems: string[] = [];

  const manifestFn = bridge.bridge_payload_manifest;
  if (typeof manifestFn !== 'function') {
    throw new Error(
      'the bridge does not export bridge_payload_manifest — rebuild it (npm run build:rust:release)',
    );
  }

  const envelope = JSON.parse(String(manifestFn())) as ManifestEnvelope;
  if (!envelope.ok || !envelope.data) {
    throw new Error(`bridge_payload_manifest failed: ${envelope.error ?? 'unknown error'}`);
  }

  const shapes = envelope.data.shapes ?? [];
  const payloads = envelope.data.payloads ?? [];
  if (shapes.length === 0) {
    throw new Error('the payload manifest carries no shapes');
  }

  // Every shape a payload names must exist, and every export a payload
  // names must be a real export of the module we just loaded.
  const shapeNames = new Set(shapes.map((shape) => shape.name));
  const realExports = new Set(
    Object.keys(bridge).filter((key) => typeof bridge[key] === 'function'),
  );

  for (const shape of shapes) {
    for (const field of shape.fields) {
      if (field.type.kind === 'named' && !shapeNames.has(field.type.name)) {
        problems.push(
          `shape ${shape.name} names the unknown shape ${field.type.name} on field ${field.name}`,
        );
      }
    }
  }

  for (const payload of payloads) {
    if (payload.shape !== null && !shapeNames.has(payload.shape)) {
      problems.push(`payload ${payload.export} names the unknown shape ${payload.shape}`);
    }
    if (!realExports.has(payload.export)) {
      problems.push(
        `the manifest describes the payload of ${payload.export}, but the bridge does not export it`,
      );
    }
  }

  return { shapes, payloads, bridgePath: path, problems };
}

function buildFixture(shapes: PayloadShape[], payloads: PayloadRow[]): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedBy: 'scripts/sync-bridge-payload-contract.mts',
      owner: 'crates/memphis-napi/src/bridge_payloads.rs',
      shapes,
      payloads,
    },
    null,
    2,
  )}\n`;
}

function tsTypeFor(field: PayloadField): string {
  let base: string;
  switch (field.type.kind) {
    case 'string':
      base = 'string';
      break;
    case 'number':
    case 'integer':
      base = 'number';
      break;
    case 'boolean':
      base = 'boolean';
      break;
    case 'bytes':
      base = 'Buffer';
      break;
    case 'json':
      base = 'unknown';
      break;
    case 'named':
      base = field.type.name;
      break;
    default:
      throw new Error(`unknown field kind on ${field.name}`);
  }

  return field.nullable ? `${base} | null` : base;
}

function buildMirror(shapes: PayloadShape[], payloads: PayloadRow[]): string {
  const shapeBlocks = shapes
    .map((shape) => {
      const lines: string[] = [];
      for (const field of shape.fields) {
        // A field with a declared legacy spelling is OPTIONAL on the wire:
        // a binary that predates the naming stabilization sends the legacy
        // name instead, so the canonical one is not guaranteed to be there.
        const optional = field.optional || Boolean(field.legacyName);
        lines.push(`  ${field.name}${optional ? '?' : ''}: ${tsTypeFor(field)};`);
        if (field.legacyName) {
          lines.push(
            `  /** The spelling before the 2026-03-21 naming stabilization. Declared by the owner. */`,
          );
          lines.push(`  ${field.legacyName}?: ${tsTypeFor(field)};`);
        }
      }
      return `export interface ${shape.name} {\n${lines.join('\n')}\n}`;
    })
    .join('\n\n');

  const mapRows = payloads
    .map((payload) => {
      const shape = payload.shape === null ? 'Buffer' : payload.shape;
      return `  ${payload.export}: ${shape};`;
    })
    .join('\n');

  return `/**
 * The bridge's payload shapes — GENERATED, do not edit.
 *
 * Projected from the Rust core's table
 * (\`crates/memphis-napi/src/bridge_payloads.rs\`) by
 * \`scripts/sync-bridge-payload-contract.mts\`. Regenerate with:
 *
 * \`\`\`bash
 * npm run -s ops:sync-bridge-payload-contract
 * \`\`\`
 *
 * The spelling of every field here is the spelling the BUILT bridge puts
 * on the wire, read off the module itself — not a guess. Where the Rust
 * owner speaks two conventions (a \`#[napi(object)]\` struct with an
 * explicit \`js_name\` speaks snake_case, one without it speaks
 * camelCase), each export keeps its own shape and the mirror says so.
 */
${shapeBlocks}

/** The payload each bridge export carries. */
export interface BridgePayloadMap {
${mapRows}
}

export type BridgePayloadExport = keyof BridgePayloadMap;

export type BridgePayloadOf<K extends BridgePayloadExport> = BridgePayloadMap[K];
`;
}

function main(): number {
  const check = process.argv.includes('--check');
  const { shapes, payloads, bridgePath, problems } = readManifest();

  if (problems.length > 0) {
    console.error('bridge payload contract FAILED\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('');
    console.error(`  bridge: ${bridgePath}`);
    return 1;
  }

  const fixture = buildFixture(shapes, payloads);
  const mirror = buildMirror(shapes, payloads);

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
      console.error('bridge payload contract gate FAILED\n');
      for (const problem of problemsFound) console.error(`  ${problem}`);
      console.error('');
      console.error('  Run: npm run -s ops:sync-bridge-payload-contract');
      return 1;
    }
    console.log(
      `[bridge-payload-contract] OK (${payloads.length} payloads, ${shapes.length} shapes, mirror in sync with the Rust core)`,
    );
    return 0;
  }

  mkdirSync(dirname(resolve(FIXTURE)), { recursive: true });
  writeFileSync(FIXTURE, fixture, 'utf8');
  writeFileSync(MIRROR, mirror, 'utf8');
  console.log(
    `[bridge-payload-contract] wrote ${FIXTURE} and ${MIRROR} (${payloads.length} payloads, ${shapes.length} shapes)`,
  );
  return 0;
}

process.exit(main());
