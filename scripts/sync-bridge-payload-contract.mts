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
  | { kind: 'string' | 'number' | 'integer' | 'boolean' | 'bytes' | 'json' | 'enum' }
  | { kind: 'named'; name: string }
  | { kind: 'array'; of: FieldType };

/** The closed set of words an enumerated field can carry. */
type Vocabulary = {
  values: string[];
  /**
   * Where the words come from — the source of truth for them.
   *
   * A source is a FUNCTION (its string literals are the words) or an
   * ENUM (its variant names are the words). The Rust gate parses the
   * same sources out of the crate and compares them with this list.
   */
  sources: string[];
  /** Literals in those sources that are NOT words of the field. */
  extraLiterals: string[];
};

type PayloadField = {
  name: string;
  type: FieldType;
  optional: boolean;
  nullable: boolean;
  /** The spelling this field had in older binaries — declared, not guessed. */
  legacyName?: string | null;
  /** The closed vocabulary of an enumerated field. */
  vocabulary?: Vocabulary | null;
};

type PayloadShape = {
  name: string;
  /** How the shape's field names reach the wire: `napiObject` or `serde`. */
  naming: 'napiObject' | 'serde';
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
  schemaVersion: number;
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
      if (field.type.kind === 'array' && field.type.of.kind === 'named') {
        if (!shapeNames.has(field.type.of.name)) {
          problems.push(
            `shape ${shape.name} lists the unknown shape ${field.type.of.name} on field ${field.name}`,
          );
        }
      }
      // An enumerated field without a vocabulary would be rendered as a
      // bare `string` — the guess this whole mechanism exists to remove.
      // A LIST of enumerated words is enumerated too: the embed
      // profile's manifest publishes three such lists.
      const enumerated =
        field.type.kind === 'enum' ||
        (field.type.kind === 'array' && field.type.of.kind === 'enum');
      if (enumerated && !field.vocabulary?.values.length) {
        problems.push(
          `shape ${shape.name} enumerates ${field.name} but declares no vocabulary`,
        );
      }
      if (!enumerated && field.vocabulary) {
        problems.push(
          `shape ${shape.name} declares a vocabulary for ${field.name}, which is not enumerated`,
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

  return {
    shapes,
    payloads,
    schemaVersion: envelope.data.schemaVersion ?? 1,
    bridgePath: path,
    problems,
  };
}

function buildFixture(
  shapes: PayloadShape[],
  payloads: PayloadRow[],
  schemaVersion: number,
): string {
  return `${JSON.stringify(
    {
      schemaVersion,
      generatedBy: 'scripts/sync-bridge-payload-contract.mts',
      owner: 'crates/memphis-napi/src/bridge_payloads.rs',
      shapes,
      payloads,
    },
    null,
    2,
  )}\n`;
}

/**
 * The TypeScript type of one field, as the owner declares it.
 *
 * An ENUM is a closed set of words, so the mirror renders the words —
 * not `string`. That is the point of the vocabulary: a surface that
 * knows the wire can say `'true' | 'provider-dependent'` instead of
 * `string`, and a typo in the wire's words is a type error.
 */
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
    case 'array': {
      const inner = tsTypeFor({ ...field, type: field.type.of, nullable: false });
      // A union of words needs its brackets: `('a' | 'b')[]`, never
      // `'a' | 'b'[]` — the second one is a union of a word and an
      // array, which is a different type and a wrong one.
      base = inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
      break;
    }
    case 'enum': {
      const vocabulary = field.vocabulary;
      if (!vocabulary || vocabulary.values.length === 0) {
        throw new Error(`the enumerated field ${field.name} declares no vocabulary`);
      }
      base = vocabulary.values.map((value) => `'${value}'`).join(' | ');
      break;
    }
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
      const convention =
        shape.naming === 'napiObject'
          ? 'an explicit `js_name` verbatim, a field without one in camelCase'
          : 'serde\'s rule — `rename_all = "camelCase"` camelCases, a field without it keeps its own name';
      return `/** ${shape.naming} — ${convention}. */\nexport interface ${shape.name} {\n${lines.join('\n')}\n}`;
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
 *
 * An ENUM field carries the CLOSED set of words the wire can send — the
 * owner declares them, and the Rust gate checks them against the source
 * that writes them. So \`normalized\` here is
 * \`'true' | 'provider-dependent'\`, not \`string\`: a wire word that
 * nobody declared is a type error, not a silent string.
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
  const { shapes, payloads, schemaVersion, bridgePath, problems } = readManifest();

  if (problems.length > 0) {
    console.error('bridge payload contract FAILED\n');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('');
    console.error(`  bridge: ${bridgePath}`);
    return 1;
  }

  const fixture = buildFixture(shapes, payloads, schemaVersion);
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
