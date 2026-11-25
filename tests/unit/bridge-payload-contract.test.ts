/**
 * The bridge's payload shapes — the TypeScript side of the contract.
 *
 * ## Why this gate exists
 *
 * E-01 gave the bridge's export VOCABULARY one owner. The SHAPE of what
 * those exports carry was still guessed, in seven TypeScript files:
 *
 * - `rust-vault-adapter.ts` declared `entries_json?` AND `entriesJson?`,
 *   `error_code?` AND `errorCode?`, `master_key?` AND `masterKey?`, and
 *   read `result.entries_json ?? result.entriesJson` — the contract was
 *   GUESSED, and the guess written down twice;
 * - `rust-embed-adapter.ts` declared `RawEmbedStoreResult` by hand, with
 *   `normalized?: boolean | string` — on the wire `normalized` is a
 *   STRING, always.
 *
 * The hedge was not caution: the Rust owner speaks TWO conventions. A
 * `#[napi(object)]` struct with an explicit `#[napi(js_name = "...")]`
 * speaks snake_case, one without it speaks camelCase. Measured 2026-11-24
 * on the built module: `vault_load_state` returns `error_code`,
 * `vault_decode_entry` returns `errorCode`, and one hand-written
 * TypeScript interface had to cover both.
 *
 * ## What this gate pins
 *
 * - the mirror is a PROJECTION of the Rust core's table, and the projection
 *   is in sync (the check mode of the projection script passes);
 * - the artefact agrees with the REAL binary — the field names in it are
 *   the names the module actually puts on the wire, checked by CALLING it;
 * - the CLOSED VOCABULARIES the artefact declares are the words the binary
 *   really writes;
 * - the TypeScript surfaces read the payload under the projected names, and
 *   the ratchet counts the surfaces that still hand-write a payload type.
 *
 * The Rust arm of the same contract is
 * `crates/memphis-napi/tests/bridge_payload_contract.rs`, and the artefact is
 * `tests/fixtures/bridge-payload-contract.json`. Neither arm produces it
 * alone.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { canonicalHash } from '../../src/core/chain-hash.js';
import { resolveRustBridgePath } from '../../src/infra/runtime/install-root.js';

type FieldType =
  | { kind: 'string' | 'number' | 'integer' | 'boolean' | 'bytes' | 'json' | 'enum' }
  | { kind: 'named'; name: string }
  | { kind: 'array'; of: FieldType };

type Vocabulary = {
  values: string[];
  /**
   * Where the words come from — a FUNCTION (its string literals are the
   * words) or an ENUM (its variant names are the words). The Rust gate
   * resolves the same sources out of the crate and compares.
   */
  sources: string[];
  extraLiterals: string[];
};

type PayloadField = {
  name: string;
  type: FieldType;
  optional: boolean;
  nullable: boolean;
  legacyName?: string | null;
  vocabulary?: Vocabulary | null;
};

type PayloadShape = {
  name: string;
  /** How the shape's field names reach the wire. */
  naming: 'napiObject' | 'serde';
  rustType: string;
  fields: PayloadField[];
  /**
   * The PER-VARIANT split, for a shape whose wire carries different
   * fields depending on the variant.
   */
  variants?: {
    tag: string;
    variants: Array<{ name: string; fields: PayloadField[] }>;
  };
};

type PayloadRow = {
  export: string;
  transport: 'envelopeJson' | 'nativeObject' | 'bytes';
  shape: string | null;
};

const FIXTURE = 'tests/fixtures/bridge-payload-contract.json';
const MIRROR = 'src/infra/storage/bridge-payloads.generated.ts';

type Artefact = {
  owner?: string;
  shapes: PayloadShape[];
  payloads: PayloadRow[];
};

function readArtefact(): Artefact {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Artefact;
}

function loadBridge(): Record<string, unknown> | null {
  const path = resolveRustBridgePath(process.env);
  if (!existsSync(path)) return null;
  try {
    const require = createRequire(`${process.cwd()}/`);
    return require(path) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// The embed probes below WRITE an index. Point them at a scratch
// directory so the operator's own index is never touched — the same
// isolation the measurement probe used.
const scratch = mkdtempSync(path.join(tmpdir(), 'memphis-payload-contract-'));
const scratchIndex = path.join(scratch, 'index-v1.json');
process.env.RUST_EMBED_PERSIST_PATH = scratchIndex;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const artefact = readArtefact();
const bridge = loadBridge();

/** The own property names of a value the bridge returned. */
function keysOf(value: unknown): string[] {
  return value && typeof value === 'object' ? Object.keys(value as Record<string, unknown>) : [];
}

/** The `data` of a bridge envelope. */
function envelopeData(name: string, ...args: unknown[]): Record<string, unknown> | null {
  if (!bridge) return null;
  const fn = bridge[name] as ((...a: unknown[]) => string) | undefined;
  if (typeof fn !== 'function') return null;
  const envelope = JSON.parse(fn(...args)) as { ok: boolean; data?: Record<string, unknown> };
  return envelope.ok ? (envelope.data ?? null) : null;
}

function shapeOf(name: string): PayloadShape {
  const shape = artefact.shapes.find((candidate) => candidate.name === name);
  expect(shape, `the artefact has no shape ${name}`).toBeDefined();
  return shape!;
}

/**
 * The mirror's text, with the WHITESPACE that prettier chose removed.
 *
 * The gate checks that the mirror renders a vocabulary — and prettier
 * decides where the lines break. A nine-word union does not fit on one
 * line, so prettier writes it as a list of `|`-prefixed lines:
 *
 * ```ts
 *   providers: (
 *     | 'openai-compatible'
 *     | 'ollama'
 *     …
 *   )[];
 * ```
 *
 * which is the SAME type as `providers: ('openai-compatible' | 'ollama' |
 * …)[]`, split across lines. So the gate normalizes both sides: whitespace
 * runs collapse to one space, and the `|` that opens a wrapped union and
 * the space before its `)` are dropped.
 *
 * MEASURED 2026-11-24: the mirror is written by the projection and
 * FORMATTED by prettier (the projection writes prettier's formatting, so
 * the file it generates is never born stale), and the vocabulary of the
 * embed-profile's nine provider names is the first thing prettier wraps.
 */
function normalizeType(text: string): string {
  return (
    text
      .replace(/\s+/g, ' ')
      // A union prettier had to wrap: `(` `|` word — the `|` and the
      // space around it are prettier's line break, not the type.
      .replace(/\(\s*\|\s*/g, '(')
      // The same, without the brackets: `type:` `|` word.
      .replace(/:\s*\|\s*/g, ': ')
      .replace(/\s*\)/g, ')')
      .trim()
  );
}

/** The mirror, normalized — the form the gate compares against. */
function normalizedMirror(): string {
  return normalizeType(readFileSync(MIRROR, 'utf8'));
}

/**
 * The source of a surface, with its COMMENTS removed.
 *
 * The ratchet looks for hand-written payload types, and the migration
 * notes that document their removal name them — in prose. A comment is
 * not a declaration, so the scan reads the code only.
 */
function codeOf(surface: string): string {
  return readFileSync(surface, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('the bridge payload contract', () => {
  it('the projection is in sync with the Rust core', () => {
    const output = execFileSync(
      'npx',
      ['tsx', 'scripts/sync-bridge-payload-contract.mts', '--check'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    expect(output).toContain('bridge-payload-contract');
  });

  it('the artefact names the owner', () => {
    expect(artefact.owner).toBe('crates/memphis-napi/src/bridge_payloads.rs');
  });

  it('every payload names a shape that exists', () => {
    const names = new Set(artefact.shapes.map((shape) => shape.name));
    for (const payload of artefact.payloads) {
      if (payload.shape === null) continue;
      expect(names.has(payload.shape)).toBe(true);
    }
  });

  it('the mirror declares every shape and every payload of the artefact', () => {
    const mirror = normalizedMirror();
    for (const shape of artefact.shapes) {
      // A shape with a PER-VARIANT split is a discriminated union, and
      // the others are interfaces. Both are declarations of the shape —
      // what the mirror must NOT do is leave one out.
      const declared =
        shape.variants && shape.variants.variants.length > 0
          ? `export type ${shape.name} =`
          : `export interface ${shape.name} {`;
      expect(mirror, `the mirror does not declare ${shape.name}`).toContain(declared);
    }
    for (const payload of artefact.payloads) {
      expect(mirror).toContain(`${payload.export}: `);
    }
  });

  it('the real binary puts the projected field names on the wire', () => {
    if (!bridge) {
      // The binary is not built in this checkout — the Rust arm still
      // checks the table against the crate's own structs.
      expect(artefact.shapes.length).toBeGreaterThan(0);
      return;
    }

    // `vault_load_state` on a missing file: the error path, which is the
    // only one reachable without a passphrase. Measured 2026-11-24: the
    // payload carries `error_code` — the struct sets an explicit
    // `#[napi(js_name = "error_code")]`.
    const loader = bridge.vault_load_state as (path: string, pepper: string) => unknown;
    const payload = loader(
      '/tmp/memphis-bridge-payload-contract-absent/vault-state.json',
      'contract-probe-pepper-contract-probe',
    ) as Record<string, unknown>;

    const shape = artefact.shapes.find((candidate) => candidate.name === 'VaultLoadStatePayload');
    expect(shape).toBeDefined();

    const declared = new Set(shape!.fields.map((field) => field.name));
    for (const key of keysOf(payload)) {
      expect(declared.has(key)).toBe(true);
    }
    // The spelling is the point: `error_code`, not `errorCode`.
    expect(Object.keys(payload)).toContain('error_code');
  });

  it('the vault entries payload speaks camelCase, as the owner says it does', () => {
    if (!bridge) return;

    // `vault_parse_entries` on malformed input: the error path. Measured
    // 2026-11-24: `errorCode` — that struct does NOT set a `js_name`, so
    // napi-rs exports it in camelCase, while its sibling
    // `JsVaultStateResult` exports `error_code`.
    const parser = bridge.vault_parse_entries as (
      raw: string,
      key: string | undefined,
      latest: boolean,
    ) => unknown;
    const payload = parser('not-json', undefined, false) as Record<string, unknown>;

    const shape = artefact.shapes.find((candidate) => candidate.name === 'VaultEntriesPayload');
    expect(shape).toBeDefined();

    const declared = new Set(shape!.fields.map((field) => field.name));
    for (const key of keysOf(payload)) {
      expect(declared.has(key)).toBe(true);
    }
    expect(Object.keys(payload)).toContain('errorCode');
    expect(Object.keys(payload)).not.toContain('error_code');
  });

  it('the embed family answers with the projected keys', () => {
    if (!bridge) return;

    const probes: Array<{ export: string; shape: string; args: unknown[] }> = [
      {
        export: 'embed_store',
        shape: 'EmbedStorePayload',
        args: ['contract-probe', 'contract probe text'],
      },
      {
        export: 'embed_store_many',
        shape: 'EmbedStoreManyPayload',
        args: [JSON.stringify([{ id: 'contract-probe-2', text: 'contract probe text 2' }])],
      },
      { export: 'embed_flush', shape: 'EmbedFlushPayload', args: [] },
      { export: 'embed_search', shape: 'EmbedSearchPayload', args: ['contract probe text', 5] },
      {
        export: 'embed_search_tuned',
        shape: 'EmbedSearchPayload',
        args: ['contract probe text', 5],
      },
    ];

    for (const probe of probes) {
      const payload = envelopeData(probe.export, ...probe.args);
      expect(payload, `${probe.export} answered nothing`).not.toBeNull();
      const declared = shapeOf(probe.shape).fields.map((field) => field.name);
      expect(
        Object.keys(payload!).sort(),
        `${probe.export} carries keys the owner does not declare`,
      ).toEqual([...declared].sort());
    }
  });

  it('the embed payload values are inside the declared vocabulary', () => {
    if (!bridge) return;

    const payload = envelopeData('embed_store', 'contract-probe-vocab', 'contract probe text');
    expect(payload).not.toBeNull();
    const shape = shapeOf('EmbedStorePayload');

    for (const field of shape.fields) {
      if (!field.vocabulary) continue;
      const value = payload![field.name];
      expect(typeof value).toBe('string');
      expect(
        field.vocabulary.values,
        `${field.name} answered "${value}", which the owner does not declare`,
      ).toContain(value as string);
    }
  });

  it('the discard payload carries the keys of its variant, and only those', () => {
    if (!bridge) return;

    // The not-initialized variant: three keys. This probe runs BEFORE any
    // other embed call in this file, so the pipeline was never built.
    const payload = envelopeData('embed_discard_replacement');
    expect(payload).not.toBeNull();

    const shape = shapeOf('EmbedDiscardPayload');
    const declared = shape.fields.map((field) => field.name);
    const required = shape.fields.filter((field) => !field.optional).map((field) => field.name);

    // Every key the binary sent is declared by the owner…
    for (const key of Object.keys(payload!)) {
      expect(declared, `${key} is not declared by the owner`).toContain(key);
    }
    // …and the keys that are always there are all there.
    for (const key of required) {
      expect(Object.keys(payload!), `${key} is missing`).toContain(key);
    }
  });

  it('the chain family answers with the projected keys', () => {
    if (!bridge) return;

    // A block the bridge ACCEPTS — the hash is the canonical one, so the
    // validation succeeds and the success path is the one without
    // `errors`.
    const data = { type: 'journal', content: 'contract probe', tags: ['probe'] };
    const timestamp = '2026-11-24T00:00:00.000Z';
    const prevHash = '0'.repeat(64);
    const block = {
      index: 0,
      timestamp,
      chain: 'journal',
      data,
      prev_hash: prevHash,
      hash: canonicalHash({
        index: 0,
        timestamp,
        chain: 'journal',
        data,
        prev_hash: prevHash,
      }),
    };

    const probes: Array<{ export: string; shape: string; args: unknown[]; keys: string[] }> = [
      {
        export: 'chain_validate',
        shape: 'ChainValidatePayload',
        args: [JSON.stringify(block)],
        // The success path: `errors` is ABSENT, not null.
        keys: ['valid'],
      },
      {
        export: 'chain_append',
        shape: 'ChainAppendPayload',
        args: ['[]', JSON.stringify(block)],
        keys: ['appended', 'length', 'chain'],
      },
      {
        export: 'chain_query',
        shape: 'ChainQueryPayload',
        args: ['[]'],
        keys: ['count', 'blocks'],
      },
    ];

    for (const probe of probes) {
      const payload = envelopeData(probe.export, ...probe.args);
      expect(payload, `${probe.export} answered nothing`).not.toBeNull();
      const declared = shapeOf(probe.shape).fields.map((field) => field.name);
      for (const key of Object.keys(payload!)) {
        expect(declared, `${probe.export} carries the undeclared key ${key}`).toContain(key);
      }
      expect(Object.keys(payload!).sort(), `${probe.export} answered another variant`).toEqual(
        [...probe.keys].sort(),
      );
    }
  });

  it('the soul family answers with the projected keys', () => {
    if (!bridge) return;

    const state = {
      steps: 0,
      tool_calls: 0,
      wait_ms: 0,
      errors: 0,
      completed: false,
      halt_reason: null,
    };

    const step = envelopeData(
      'soul_loop_step',
      JSON.stringify(state),
      JSON.stringify({ type: 'wait', data: { duration_ms: 10 } }),
    );
    expect(step).not.toBeNull();
    // The applied path: `reason` is ABSENT.
    expect(Object.keys(step!).sort()).toEqual(['applied', 'state']);
    const declared = shapeOf('SoulLoopStepPayload').fields.map((field) => field.name);
    for (const key of Object.keys(step!)) {
      expect(declared, `soul_loop_step carries the undeclared key ${key}`).toContain(key);
    }
    expect(Object.keys(step!.state as Record<string, unknown>).sort()).toEqual([
      'completed',
      'errors',
      'halt_reason',
      'steps',
      'tool_calls',
      'wait_ms',
    ]);

    const replay = envelopeData('soul_replay', 'journal', '[]');
    expect(replay).not.toBeNull();
    expect(Object.keys(replay!).sort()).toEqual(['accepted', 'errors', 'rejected', 'snapshot']);
    expect(Object.keys(replay!.snapshot as Record<string, unknown>).sort()).toEqual([
      'blocks',
      'last_hash',
      'state_hash',
    ]);
  });

  it('the case family answers with the projected keys', () => {
    if (!bridge) return;

    // The case index lives in the scratch directory — the operator's own
    // index is never touched by this probe.
    const indexDbPath = path.join(scratch, 'case-index.sqlite');

    const entry = {
      case_type: 'nominative',
      entity: 'Contract Probe',
      action: 'probed',
      timestamp: '2026-11-24T00:00:00.000Z',
    };

    const appended = envelopeData('case_append', '[]', JSON.stringify(entry), indexDbPath);
    expect(appended).not.toBeNull();
    expect(Object.keys(appended!).sort()).toEqual(['appended', 'chain', 'indexed', 'length']);

    const queried = envelopeData('case_query', JSON.stringify({}), indexDbPath);
    expect(queried).not.toBeNull();
    expect(Object.keys(queried!).sort()).toEqual(['count', 'entries']);

    const rows = queried!.entries as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    // The row carries SIX keys — and the one that carries the case
    // itself. The hand-written TypeScript row had twenty-four fields and
    // was missing this one.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'block_hash',
      'block_index',
      'case_type',
      'chain',
      'entry',
      'full_json',
    ]);
    expect((rows[0]!.entry as Record<string, unknown>).case_type).toBe('nominative');

    const rebuilt = envelopeData('case_rebuild', '[]', indexDbPath);
    expect(rebuilt).not.toBeNull();
    // Three keys — the TypeScript side knew two of them.
    expect(Object.keys(rebuilt!).sort()).toEqual(['errors', 'indexed', 'skipped']);
  });

  it('the case entry carries ITS OWN fields, and only its own', () => {
    if (!bridge) return;

    // THE PER-VARIANT SPLIT, ON THE WIRE.
    //
    // A tagged enum puts ONE variant's fields on the wire: a genitive
    // carries `owner` and `possessed` and NOTHING else — no `entity`, no
    // `verb`, no `timestamp`. MEASURED 2026-11-24 on this host: the flat
    // shape said `entity?`, and a flat shape cannot say "not on this
    // variant" — it is the union by construction.
    //
    // The falsifier for the gate that was missing: the owner grew a field
    // on `CaseEntry::Dative`, the owner's table and the generated mirror
    // grew it with it, the Rust contract gate was green, `tsc` was clean
    // and this suite was green — while the hand-written TypeScript union
    // still did not have the field. The union is now the owner's
    // projection, and this test says what the wire really carries.
    const indexDbPath = path.join(scratch, 'case-variants-index.sqlite');

    const genitive = {
      case_type: 'genitive',
      owner: 'soul',
      possessed: 'user.name',
    };

    const appended = envelopeData('case_append', '[]', JSON.stringify(genitive), indexDbPath);
    expect(appended).not.toBeNull();

    const queried = envelopeData('case_query', JSON.stringify({}), indexDbPath);
    expect(queried).not.toBeNull();

    const rows = queried!.entries as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);

    const entry = rows[0]!.entry as Record<string, unknown>;
    // THREE keys: the tag and the genitive's own two. NOT `entity`, NOT
    // `timestamp` — those are the nominative's.
    expect(Object.keys(entry).sort()).toEqual(['case_type', 'owner', 'possessed']);
    expect(entry.case_type).toBe('genitive');
    expect(entry.entity).toBeUndefined();
    expect(entry.timestamp).toBeUndefined();
  });

  it('the mirror renders the per-variant split as a discriminated union', () => {
    // The artefact carries the split, and the mirror renders one arm per
    // variant — with the tag as a LITERAL, because the fields that follow
    // depend on it.
    const shape = shapeOf('CaseEntryPayload');
    expect(shape.variants, 'the artefact carries no per-variant split').toBeDefined();
    expect(shape.variants!.tag).toBe('case_type');

    const variants = shape.variants!.variants.map((variant) => variant.name);
    expect(variants).toEqual([
      'nominative',
      'genitive',
      'dative',
      'accusative',
      'instrumental',
      'locative',
      'ablative',
      'vocative',
    ]);

    // The per-variant fields, from the artefact — the same eight sets the
    // owner declares. MEASURED 2026-11-24: `entity` and `timestamp`
    // belong to the nominative alone.
    const fieldsOf = (name: string): string[] =>
      shape
        .variants!.variants.find((variant) => variant.name === name)!
        .fields.map((field) => field.name);

    expect(fieldsOf('nominative')).toEqual(['entity', 'action', 'timestamp']);
    expect(fieldsOf('genitive')).toEqual(['owner', 'possessed']);
    expect(fieldsOf('dative')).toEqual(['giver', 'recipient', 'object']);
    expect(fieldsOf('accusative')).toEqual(['subject', 'verb', 'object']);
    expect(fieldsOf('instrumental')).toEqual(['actor', 'instrument', 'target']);
    expect(fieldsOf('locative')).toEqual(['entity', 'location']);
    expect(fieldsOf('ablative')).toEqual(['entity', 'origin', 'destination']);
    expect(fieldsOf('vocative')).toEqual(['invoker', 'invocation', 'target']);

    // The union of the variants' fields is the flat shape — and the
    // `destination` of the ablative is OPTIONAL and NOT nullable: it is
    // an `Option` with `skip_serializing_if`, so it is ABSENT when it has
    // no value, never null.
    const destination = shape
      .variants!.variants.find((variant) => variant.name === 'ablative')!
      .fields.find((field) => field.name === 'destination')!;
    expect(destination.optional).toBe(true);
    expect(destination.nullable).toBe(false);

    // And the MIRROR renders it as a union, not as a flat interface.
    const mirror = normalizedMirror();
    expect(mirror).toContain('export type CaseEntryPayload =');
    expect(mirror).toContain(
      "| { case_type: 'nominative'; entity: string; action: string; timestamp: string }",
    );
    expect(mirror).toContain("| { case_type: 'genitive'; owner: string; possessed: string }");
    expect(mirror).not.toContain('export interface CaseEntryPayload');
  });

  it('the case family has no hand-written payload type left', () => {
    // The case family is done: the row, the query's answer and the
    // rebuild's answer are all the owner's shapes — and so is the ENTRY,
    // which used to be a hand-written union in `src/memory/case-types.ts`
    // that nothing compared with the owner.
    const surface = 'src/memory/case-types.ts';
    const code = codeOf(surface);

    // The domain model's union is the owner's projection, under the name
    // the domain uses — not a second copy of it. The union LITERAL is
    // gone; what is left is the alias.
    expect(code).toMatch(/export type CaseEntry = CaseEntryPayload;/);
    expect(code).not.toMatch(/case_type: 'nominative'/);
    expect(code).not.toMatch(/case_type: 'genitive'/);
  });

  it('the manifest family has no hand-written payload type left', () => {
    // The manifest's shape was written down TWICE — once in the runtime's
    // `RustBridgeManifest` and once in the export projection's reader —
    // and the two copies disagreed with the wire: the runtime marked
    // `exportBindings` and `optionalExports` OPTIONAL while the wire
    // always sends them, and `optionalExports` — the field the wire
    // carried wrong — was read by nobody at all.
    const offenders: string[] = [];
    const surfaces = [
      'src/infra/storage/rust-bridge-manifest.ts',
      'scripts/sync-bridge-export-contract.mts',
    ];
    const handWritten = [
      'interface RustBridgeManifest {',
      'jsName: string;',
      'optionalExports?: string[];',
      'exportBindings?: Binding[];',
    ];

    for (const surface of surfaces) {
      const source = codeOf(surface);
      for (const marker of handWritten) {
        if (source.includes(marker)) offenders.push(`${surface}: ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the manifest answers with the projected keys', () => {
    if (!bridge) return;

    const manifestFn = bridge.bridge_manifest as (() => string) | undefined;
    if (typeof manifestFn !== 'function') return;

    const envelope = JSON.parse(manifestFn()) as {
      ok: boolean;
      data?: Record<string, unknown>;
    };
    expect(envelope.ok).toBe(true);

    const declared = shapeOf('BridgeManifestPayload').fields.map((field) => field.name);
    expect(Object.keys(envelope.data!).sort()).toEqual([...declared].sort());

    // The optional list is DERIVED from the export table — it used to be a
    // hand-written pair (`mv2_export`, `mv2_inspect`) from June 2026, while
    // the table already knew ten optional exports. This is the check that
    // keeps it derived.
    const optional = envelope.data!.optionalExports as string[];
    const bindings = envelope.data!.exportBindings as Array<{
      canonical: string;
      required: boolean;
    }>;
    expect(optional.sort()).toEqual(
      bindings
        .filter((binding) => !binding.required)
        .map((binding) => binding.canonical)
        .sort(),
    );
  });

  it('the mirror renders the closed vocabularies, not a bare string', () => {
    const mirror = normalizedMirror();
    for (const shape of artefact.shapes) {
      for (const field of shape.fields) {
        if (!field.vocabulary) continue;
        const union = field.vocabulary.values.map((value) => `'${value}'`).join(' | ');
        // A LIST of words is `('a' | 'b')[]`. The brackets are not
        // cosmetics: `'a' | 'b'[]` is a union of a word and an array,
        // which is a different type — and a wrong one.
        const isList = field.type.kind === 'array' && field.type.of.kind === 'enum';
        const rendered = isList ? `(${union})[]` : union;
        // An OPTIONAL key is rendered with a `?` — the mirror's spelling
        // of "this key may be absent".
        const optional = field.optional || Boolean(field.legacyName);
        // A shape with a PER-VARIANT split renders its tag as a LITERAL
        // per arm — the tag is the discriminator, so the words are the
        // arm's own name, not a union of all eight.
        if (shape.variants && shape.variants.variants.length > 0) {
          for (const variant of shape.variants.variants) {
            expect(mirror, `${shape.name} lost the ${variant.name} arm`).toContain(
              `${shape.variants!.tag}: '${variant.name}'`,
            );
          }
          continue;
        }
        expect(mirror, `${shape.name}.${field.name} lost its vocabulary`).toContain(
          `${field.name}${optional ? '?' : ''}: ${rendered}`,
        );
      }
    }
  });

  it('no TypeScript surface guesses a payload field name any more', () => {
    // The ratchet. Each of these was a hedge over two spellings, and each
    // hedge was a guess about a contract the owner already knew.
    const surfaces = [
      'src/infra/storage/rust-vault-adapter.ts',
      'src/infra/storage/rust-embed-adapter.ts',
      'src/infra/storage/rust-chain-adapter.ts',
      'src/infra/storage/case-chain-adapter.ts',
      'src/infra/storage/rust-bridge-manifest.ts',
      'src/infra/runtime/embedding-metadata.ts',
      'src/infra/storage/rust-embed-profile-bridge.ts',
    ];

    const guesses = ['entries_json ??', 'error_code ??', 'createdAt ?? entry.created_at'];

    const offenders: string[] = [];
    for (const surface of surfaces) {
      const source = readFileSync(surface, 'utf8');
      for (const guess of guesses) {
        if (source.includes(guess)) {
          offenders.push(`${surface}: ${guess}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the embed family has no hand-written payload type left', () => {
    // The embed family is migrated. These were the hand-written copies —
    // one of them (`RawEmbedStoreResult`) had the WRONG type for
    // `normalized`, and the chain adapter's three copies were DEAD.
    const offenders: string[] = [];
    const surfaces = [
      'src/infra/storage/rust-embed-adapter.ts',
      'src/infra/storage/rust-chain-adapter.ts',
      'src/infra/runtime/embedding-metadata.ts',
    ];
    const handWritten = [
      'RawEmbedStoreResult',
      'RawEmbedSearchResult',
      'interface EmbedSearchHit {',
      'interface EmbedStoreResult {',
      'interface EmbedSearchResult {',
      'interface EmbedStoreManyResult {',
    ];

    for (const surface of surfaces) {
      const source = readFileSync(surface, 'utf8');
      for (const marker of handWritten) {
        if (source.includes(marker)) offenders.push(`${surface}: ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the surfaces that still own a payload type are counted, not forgotten', () => {
    // E-09 is closed family by family. This is the counter: the surfaces
    // that STILL declare a bridge payload type by hand, with the marker
    // that proves it. It may only go DOWN — when a surface is migrated, it
    // leaves this list and the count drops.
    //
    // The vault, embed, chain, soul, case, manifest AND embed-profile
    // families are migrated: their shapes come from
    // `bridge-payloads.generated.ts`. The counter is EMPTY, and it is
    // empty on purpose — a count of one would be a surface the owner does
    // not cover.
    const stillToMigrate: Record<string, string> = {};

    expect(Object.keys(stillToMigrate).length).toBe(0);

    for (const [surface, marker] of Object.entries(stillToMigrate)) {
      expect(readFileSync(surface, 'utf8')).toContain(marker);
    }

    // A surface that is NOT on the list must not declare a payload type of
    // its own — that is what stops the count from growing back.
    const migrated = [
      'src/infra/storage/rust-vault-adapter.ts',
      'src/infra/storage/rust-embed-adapter.ts',
      'src/infra/runtime/embedding-metadata.ts',
      'src/infra/storage/rust-chain-adapter.ts',
      'src/infra/storage/case-chain-adapter.ts',
      'src/infra/storage/rust-bridge-manifest.ts',
      'src/infra/storage/rust-embed-profile-bridge.ts',
    ];
    for (const surface of migrated) {
      expect(Object.keys(stillToMigrate)).not.toContain(surface);
      // The migrated surface must read the shape through the OWNER.
      expect(readFileSync(surface, 'utf8')).toContain('bridge-payloads.generated.js');
    }
  });

  it('the embed-profile family has no hand-written payload type left', () => {
    // The last family of E-09. Its hand-written interface declared
    // `modes` with TWO keys — `local` and `providers` — while the wire
    // has carried THREE since the manifest was written: `alias`, the word
    // that means "the OpenAI-compatible provider", was missing from the
    // type. A type that does not describe the wire is a guess, and this
    // is where the guess lived.
    const offenders: string[] = [];
    const surfaces = ['src/infra/storage/rust-embed-profile-bridge.ts'];
    const handWritten = [
      'interface EmbedProfileManifest {',
      'interface EmbedProfileFacts {',
      'dimensionSources: string[];',
      'verdicts: string[];',
      'dimensionSource: string;',
      'modelSource: string;',
      'verdict: string;',
    ];

    for (const surface of surfaces) {
      const source = codeOf(surface);
      for (const marker of handWritten) {
        if (source.includes(marker)) offenders.push(`${surface}: ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the embed-profile family answers with the projected keys', () => {
    if (!bridge) return;

    const manifest = envelopeData('bridge_embed_profile_manifest');
    expect(manifest, 'bridge_embed_profile_manifest answered nothing').not.toBeNull();

    const declared = shapeOf('EmbedProfileManifestPayload').fields.map((field) => field.name);
    expect(Object.keys(manifest!).sort()).toEqual([...declared].sort());

    // The key the hand-written interface did not know. The wire has
    // carried it since the manifest was written — and the owner's shape
    // declares it, so the two are compared, not two hand-written lists.
    const modes = manifest!.modes as Record<string, unknown>;
    const declaredModes = shapeOf('EmbedProfileModesPayload').fields.map((field) => field.name);
    expect(Object.keys(modes).sort()).toEqual([...declaredModes].sort());
    expect(Object.keys(modes)).toContain('alias');
    expect(modes.alias).toBe('provider');

    // The facts: one environment, asked through the same bridge the
    // surfaces use. The index is the scratch one, so the operator's own
    // index is never touched.
    const env = {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_DIM: '32',
      RUST_EMBED_PERSIST_PATH: path.join(scratch, 'profile-index-v1.json'),
    };
    const facts = envelopeData('bridge_embed_profile_facts', JSON.stringify(env), scratch);
    expect(facts, 'bridge_embed_profile_facts answered nothing').not.toBeNull();

    const declaredFacts = shapeOf('EmbedProfileFactsPayload').fields.map((field) => field.name);
    expect(Object.keys(facts!).sort()).toEqual([...declaredFacts].sort());

    // The closed words the facts carry are the owner's.
    const factsShape = shapeOf('EmbedProfileFactsPayload');
    for (const field of factsShape.fields) {
      if (!field.vocabulary) continue;
      const value = facts![field.name];
      expect(typeof value).toBe('string');
      expect(
        field.vocabulary.values,
        `${field.name} answered "${value}", which the owner does not declare`,
      ).toContain(value as string);
    }
  });

  it('the embed-profile manifest publishes the closed word lists', () => {
    if (!bridge) return;

    const manifest = envelopeData('bridge_embed_profile_manifest');
    expect(manifest).not.toBeNull();

    // The lists the manifest publishes are the owner's own lists — and
    // the owner's are read out of its CONSTANTS by the Rust gate, so a
    // word nobody declares cannot get in here.
    const sources = manifest!.dimensionSources as string[];
    const verdicts = manifest!.verdicts as string[];
    const providers = (manifest!.modes as Record<string, unknown>).providers as string[];

    const dimensionSource = shapeOf('EmbedProfileManifestPayload').fields.find(
      (field) => field.name === 'dimensionSources',
    );
    const verdictField = shapeOf('EmbedProfileManifestPayload').fields.find(
      (field) => field.name === 'verdicts',
    );
    const providerField = shapeOf('EmbedProfileModesPayload').fields.find(
      (field) => field.name === 'providers',
    );

    expect(dimensionSource?.vocabulary?.values).toEqual(sources);
    expect(verdictField?.vocabulary?.values).toEqual(verdicts);
    expect(providerField?.vocabulary?.values).toEqual(providers);
  });

  it('the chain, soul and case families have no hand-written payload type left', () => {
    // The case family was the worst of them: `case-types.ts` declared a
    // row with TWENTY-FOUR fields, while the wire sends SIX — and the
    // one that carries the case itself was missing. The two query paths
    // of the same adapter therefore answered with two different shapes.
    const offenders: string[] = [];
    const surfaces = [
      'src/infra/storage/rust-chain-adapter.ts',
      'src/infra/storage/case-chain-adapter.ts',
      'src/memory/case-types.ts',
      'src/infra/cli/commands/explain.ts',
    ];
    const handWritten = [
      'interface ValidateBlockResult {',
      'interface QueryBlocksResult {',
      'interface SoulReplayResult {',
      'interface SoulReplaySnapshot {',
      'interface SoulLoopState {',
      'interface SoulLoopStepResult {',
      'interface CaseIndexRow {',
      'interface CaseQueryResult {',
      'interface CaseRebuildReport {',
      // The flat fields the wire never sends.
      'entry_timestamp',
      'indexed_at',
      'extractFields',
    ];

    for (const surface of surfaces) {
      const source = codeOf(surface);
      for (const marker of handWritten) {
        if (source.includes(marker)) offenders.push(`${surface}: ${marker}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the case domain model still knows the eight cases', () => {
    // The domain union is the stricter half of the contract — it says
    // which fields belong to which case. Its tag words must be the
    // owner's: the two lists are the same eight names, spelled the same
    // way, or the query would filter on words the entry never carries.
    const artefactRow = shapeOf('CaseEntryPayload');
    const tag = artefactRow.fields.find((field) => field.name === 'case_type');
    expect(tag).toBeDefined();
    expect(tag!.type.kind).toBe('enum');

    const source = readFileSync('src/memory/case-types.ts', 'utf8');
    const list = source.match(/export const CASE_TYPES = \[([^\]]*)\]/s);
    expect(list, 'the domain model has no CASE_TYPES list').toBeDefined();
    const words = (list![1].match(/'[a-z]+'/g) ?? []).map((word) => word.replace(/'/g, ''));
    expect(words.sort()).toEqual([...(tag!.vocabulary?.values ?? [])].sort());
  });

  it('every compat read pairs a canonical name with a DECLARED legacy one', () => {
    // The positive half of the ratchet: what the surfaces read as a
    // compatibility fallback must be exactly the pair the owner declares.
    // The two spellings that exist are the ones the naming stabilization
    // of 2026-03-21 changed — `master_key` and `created_at`.
    const mirror = normalizedMirror();
    const source = readFileSync('src/infra/storage/rust-vault-adapter.ts', 'utf8');

    const declaredPairs: Array<{ canonical: string; legacy: string }> = [];
    for (const shape of artefact.shapes) {
      for (const field of shape.fields) {
        if (!field.legacyName) continue;
        declaredPairs.push({ canonical: field.name, legacy: field.legacyName });
        expect(mirror).toContain(field.legacyName);
      }
    }

    expect(declaredPairs.length).toBeGreaterThan(0);

    for (const pair of declaredPairs) {
      const pattern = new RegExp(`${pair.canonical}\\s*\\?\\?[^;]*${pair.legacy}`);
      expect(pattern.test(source)).toBe(true);
    }
  });

  it('the vault adapter reads the payload through the generated types', () => {
    const source = readFileSync('src/infra/storage/rust-vault-adapter.ts', 'utf8');
    expect(source).toContain('bridge-payloads.generated.js');
    expect(source).toContain('BridgePayloadOf<');
  });

  it('the embed adapter reads the payload through the generated types', () => {
    const source = readFileSync('src/infra/storage/rust-embed-adapter.ts', 'utf8');
    expect(source).toContain('bridge-payloads.generated.js');
    expect(source).toContain('BridgePayloadOf<');
  });
});
