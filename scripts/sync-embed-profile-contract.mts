/**
 * Project the embed-profile contract from the Rust owner into the TypeScript
 * mirror, and check that the two agree.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Which embedding profile is in force?" had FOUR answers on this host, and
 * the answers contradicted each other:
 *
 *   1. `crates/memphis-operator/src/config.rs` — the dimension default was
 *      `32`, hard-coded;
 *   2. `crates/memphis-napi/src/lib.rs` — the same `32`, hard-coded again,
 *      and the same mode vocabulary copied a second time;
 *   3. `src/infra/http/health.ts` — the dimension default was `32` again,
 *      and the index-path default was `~/.memphis/embed/index-v1.json`
 *      (HOME-based) while the Rust side used `<data_dir>/embed/index-v1.json`
 *      (data-dir-based) — two different files whenever `MEMPHIS_DATA_DIR`
 *      is not `~/.memphis`;
 *   4. `src/infra/tensors/status.ts` — `32` a fourth time, and the
 *      HOME-based path a third time.
 *
 * MEASURED 2026-11-23 on the operator's host:
 *
 * | process | index it reads | dim | result |
 * | --- | --- | --- | --- |
 * | the service (systemd passes `.env`) | `embed/bge-m3-20261106/index-v1.json` | 1024 | `mode: semantic` |
 * | a shell, the CLI, a spawned script | `embed/index-v1.json` (stale) | 768 on disk vs **32** configured | `index_dimension_mismatch` |
 *
 * The `32` was never an embedding dimension. It is `DEFAULT_EMBEDDING_DIM` —
 * the width of the LOCAL DETERMINISTIC embedder, the placeholder used when
 * no provider is configured. The configuration builder applied it
 * unconditionally, so a process with a real provider and no explicit
 * `RUST_EMBED_DIM` asked for 32-dim vectors from a model that produces 1024.
 *
 * THE HOUSE PATTERN
 * -----------------
 * The Rust owner (`crates/memphis-embed/src/profile.rs` — ONE module) owns
 * the rule. This script copies that rule into:
 *
 *   - `tests/fixtures/embed-profile-contract.json` — the artefact of cases, and
 *   - `src/infra/storage/embed-profile.generated.ts` — the TypeScript mirror,
 *     which is therefore a PROJECTION and not a second hand-written copy.
 *
 * Both sides check themselves against the artefact: the Rust arm in
 * `crates/memphis-operator/tests/embed_profile_contract.rs`, the TypeScript
 * arm in `tests/unit/embed-profile-contract.test.ts`. Neither produces it
 * alone, so neither can change it alone.
 *
 * THE OWNER IS THE THIRD WITNESS
 * -------------------------------
 * The script reads the rule and every case's verdict through the BUILT
 * BRIDGE — through the owner's own functions, not through a second
 * implementation of the rule written here. A projection that re-implemented
 * the rule would be a fourth copy of it, and the artefact would then be
 * checking the projection against itself.
 *
 * THE CORPUS IS FIXED
 * -------------------
 * Every case names its own index by a path RELATIVE to the repository root
 * (`tests/fixtures/embed-profile/...`), and the artefact records that
 * relative form. An absolute path would make the artefact different on
 * every machine, and a gate that changes when nothing changed is a gate
 * nobody reads. The fixture indexes are committed, so the cases do not read
 * the operator's disk — a case that read `~/.memphis/embed/index-v1.json`
 * would answer differently on a fresh machine than on this one.
 *
 * Write: npm run -s ops:sync-embed-profile-contract
 * Check: npm run -s ops:sync-embed-profile-contract -- --check  (exit 1 on drift)
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const FIXTURE = 'tests/fixtures/embed-profile-contract.json';
const MIRROR = 'src/infra/storage/embed-profile.generated.ts';

/** The directory the relative paths in the corpus resolve against. */
const ROOT = process.cwd();

/**
 * The corpus of environments the profile is exercised against.
 *
 * Every case pins the index it reads, because the DEFAULT index
 * (`<data_dir>/embed/index-v1.json`) exists on the operator's host and does
 * not exist on a fresh one — a case that relied on the default would give a
 * different answer on every machine.
 */
const CORPUS: ReadonlyArray<{ name: string; env: Record<string, string> }> = [
  {
    name: 'a provider with an explicit dimension that matches the index',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_DIM: '768',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: "a provider whose explicit dimension disagrees with the index",
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_DIM: '32',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'a provider with no explicit dimension follows the index on disk',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'a provider with no index yet falls back to the local width',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/absent/index-v1.json',
    },
  },
  {
    name: 'a process without a provider says so outright',
    env: {
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'a process without a provider and without an index',
    env: {
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/absent/index-v1.json',
    },
  },
  {
    name: 'a mode word outside the vocabulary is not a provider',
    env: {
      RUST_EMBED_MODE: 'not-a-provider',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'the provider alias resolves to the openai-compatible provider',
    env: {
      RUST_EMBED_MODE: 'provider',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-1024.json',
    },
  },
  {
    name: 'a configured model is reported with its source',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_PROVIDER_MODEL: 'bge-m3',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-1024.json',
    },
  },
  {
    name: 'a dimension of zero is not a dimension',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_DIM: '0',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'the local mode is the local mode',
    env: {
      RUST_EMBED_MODE: 'local',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-768.json',
    },
  },
  {
    name: 'the default index path is under the data dir',
    env: {
      MEMPHIS_DATA_DIR: 'tests/fixtures/embed-profile/data',
      RUST_EMBED_MODE: 'ollama',
    },
  },
  {
    name: 'an explicit index path wins over the data dir',
    env: {
      MEMPHIS_DATA_DIR: 'tests/fixtures/embed-profile/data',
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/index-1024.json',
    },
  },
  {
    name: 'a provider with an explicit dimension and no index at all',
    env: {
      RUST_EMBED_MODE: 'ollama',
      RUST_EMBED_DIM: '1024',
      RUST_EMBED_PERSIST_PATH: 'tests/fixtures/embed-profile/absent/index-v1.json',
    },
  },
];

type Manifest = {
  schemaVersion: number;
  env: { indexPath: string; dimension: string; model: string; mode: string };
  defaults: { indexPath: string; dimension: string; model: string; localDimension: number };
  dimensionSources: string[];
  verdicts: string[];
  modes: { local: string; alias: string; providers: string[] };
};

type Facts = {
  schemaVersion: number;
  indexPath: string;
  indexDimension: number | null;
  configuredDimension: number | null;
  dimension: number;
  dimensionSource: string;
  model: string | null;
  modelSource: string;
  providerConfigured: boolean;
  dimensionMismatch: boolean;
  mode: string;
  verdict: string;
  remedy: string | null;
  dimensionRemedy: string | null;
};

type Envelope<T> = { ok?: boolean; data?: T; error?: string };

type BridgeModule = Record<string, unknown>;

function loadBridge(): { bridge: BridgeModule; path: string } {
  const path = resolve('crates/memphis-napi/index.node');
  if (!existsSync(path)) {
    throw new Error(
      `the native bridge is missing at ${path} — build it first (npm run build:rust:release)`,
    );
  }
  const require = createRequire(`${process.cwd()}/`);
  const bridge = require(path) as BridgeModule;
  return { bridge, path };
}

function readManifest(bridge: BridgeModule): Manifest {
  const manifestFn = bridge.bridge_embed_profile_manifest;
  if (typeof manifestFn !== 'function') {
    throw new Error('the bridge does not export bridge_embed_profile_manifest');
  }
  const envelope = JSON.parse(String(manifestFn())) as Envelope<Manifest>;
  if (!envelope.ok || !envelope.data) {
    throw new Error(`bridge_embed_profile_manifest failed: ${envelope.error ?? 'unknown error'}`);
  }
  return envelope.data;
}

function readFacts(bridge: BridgeModule, env: Record<string, string>): Facts {
  const factsFn = bridge.bridge_embed_profile_facts;
  if (typeof factsFn !== 'function') {
    throw new Error('the bridge does not export bridge_embed_profile_facts');
  }
  const envelope = JSON.parse(String(factsFn(JSON.stringify(env), ROOT))) as Envelope<Facts>;
  if (!envelope.ok || !envelope.data) {
    throw new Error(
      `bridge_embed_profile_facts failed for ${JSON.stringify(env)}: ${envelope.error ?? 'unknown error'}`,
    );
  }
  return envelope.data;
}

/**
 * The index path in the ROOT-RELATIVE form.
 *
 * The owner answers with an absolute path (it resolves against the root),
 * which would make the artefact machine-dependent. The relative form is
 * stable; an absolute path outside the root is kept as-is, because there is
 * no relative form of it that means anything.
 */
function relativize(absolutePath: string): string {
  if (!isAbsolute(absolutePath)) return absolutePath;
  const rel = relative(ROOT, absolutePath);
  if (!rel || rel.startsWith('..')) return absolutePath;
  return rel;
}

/**
 * The remedy, with the absolute path replaced by the relative form.
 *
 * The owner's remedy is PROSE for a live host, and it names the index it
 * is talking about — an absolute path, because that is what the operator
 * needs to see. In the artefact that same string would carry this
 * machine's directory layout into every other machine's checkout, and the
 * gate would fail on every runner but this one.
 *
 * This is a PRESENTATION normalisation, not a second implementation of the
 * rule: the words are the owner's, only the path is spelled the way the
 * artefact spells paths everywhere else.
 */
function relativizeRemedy(remedy: string | null, absolutePath: string, relativePath: string): string | null {
  if (!remedy) return null;
  if (absolutePath === relativePath) return remedy;
  return remedy.split(absolutePath).join(relativePath);
}

function buildFixture(manifest: Manifest, cases: Array<Record<string, unknown>>): string {
  return `${JSON.stringify(
    {
      comment:
        'The embed-profile contract — the ONE rule that decides which embedding index is read, ' +
        'how wide its vectors are, and whether the process can use a provider at all. ' +
        'The owner is the Rust crate (`crates/memphis-embed/src/profile.rs`); the TypeScript arm is a ' +
        'projection of it (`src/infra/storage/embed-profile.generated.ts`). Both arms check themselves ' +
        'against THIS file: the Rust runner is ' +
        '`crates/memphis-operator/tests/embed_profile_contract.rs`, the TypeScript runner is ' +
        '`tests/unit/embed-profile-contract.test.ts`. ' +
        'WHY: the rule had four owners and four answers. Measured 2026-11-23 on the operator\'s host, ' +
        'the service answered `mode: semantic` with dim 1024 while a shell, the CLI and any spawned ' +
        'script answered dim 32 — `DEFAULT_EMBEDDING_DIM`, the width of the LOCAL DETERMINISTIC ' +
        'embedder, applied even with a provider configured — and the index on disk holds 768. ' +
        'WHAT: `dimensionSource` is `env`, `index` or `local-deterministic`; `verdict` is `ok`, ' +
        '`no-provider`, `no-index` or `dimension-mismatch`; `indexPath` is ROOT-RELATIVE so the ' +
        'artefact is the same on every machine. ' +
        'The corpus is fixed on purpose: every case names its own committed fixture index, because a ' +
        'case that read the operator\'s `~/.memphis/embed/index-v1.json` would answer differently on ' +
        'a fresh machine than on this one.',
      schemaVersion: 1,
      generatedBy: 'scripts/sync-embed-profile-contract.mts',
      owner: 'crates/memphis-embed/src/profile.rs',
      manifest,
      cases,
    },
    null,
    2,
  )}\n`;
}

function buildMirror(manifest: Manifest): string {
  const providers = manifest.modes.providers.map((name) => `  '${name}',`).join('\n');
  const sources = manifest.dimensionSources.map((name) => `  '${name}',`).join('\n');
  const verdicts = manifest.verdicts.map((name) => `  '${name}',`).join('\n');

  return `/**
 * The embed-profile vocabulary — GENERATED, do not edit.
 *
 * Projected from the Rust owner's manifest
 * (\`crates/memphis-embed/src/profile.rs\`) by
 * \`scripts/sync-embed-profile-contract.mts\`. Regenerate with:
 *
 * \`\`\`bash
 * npm run -s ops:sync-embed-profile-contract
 * \`\`\`
 *
 * WHAT THIS IS
 * ------------
 * The NAMES and the DEFAULTS of the embedding profile — the environment
 * variables it reads, the order its dimension sources are consulted in, the
 * verdicts it can report, the provider names its mode accepts, and the width
 * of the local deterministic embedder.
 *
 * It is NOT the rule itself. The rule lives in the owner and is asked
 * through the bridge (\`src/infra/storage/rust-embed-profile-bridge.ts\`),
 * so this side never decides which index is read or how wide it is. What
 * this side must not do is carry its OWN copy of the names — the copy that
 * made a process answer dim 32 while the service answered 1024.
 *
 * The local width is the LAST resort: it is what the local deterministic
 * embedder produces, and it is only reached when there is no index on disk
 * to contradict it. A provider's own width is never guessed from a name.
 */
export const EMBED_PROFILE_ENV = {
  indexPath: '${manifest.env.indexPath}',
  dimension: '${manifest.env.dimension}',
  model: '${manifest.env.model}',
  mode: '${manifest.env.mode}',
} as const;

/** The dimension sources, in the order the owner consults them. */
export const EMBED_PROFILE_DIMENSION_SOURCES = [
${sources}
] as const;

/** The verdicts the owner can report. */
export const EMBED_PROFILE_VERDICTS = [
${verdicts}
] as const;

/** The mode word that means "no provider". */
export const EMBED_PROFILE_LOCAL_MODE = '${manifest.modes.local}';

/** The mode word that means "the OpenAI-compatible provider". */
export const EMBED_PROFILE_PROVIDER_ALIAS = '${manifest.modes.alias}';

/** The provider names the mode accepts. */
export const EMBED_PROFILE_PROVIDER_MODES = [
${providers}
] as const;

/** The width of the local deterministic embedder — the LAST resort. */
export const EMBED_PROFILE_LOCAL_DIMENSION = ${manifest.defaults.localDimension};

/** Where the index lives when the environment does not name one. */
export const EMBED_PROFILE_DEFAULT_INDEX_PATH = '${manifest.defaults.indexPath}';

export type EmbedProfileVerdict = (typeof EMBED_PROFILE_VERDICTS)[number];
export type EmbedProfileDimensionSource = (typeof EMBED_PROFILE_DIMENSION_SOURCES)[number];
`;
}

function main(): number {
  const check = process.argv.includes('--check');
  const { bridge, path: bridgePath } = loadBridge();
  const manifest = readManifest(bridge);

  const cases = CORPUS.map((entry) => {
    const facts = readFacts(bridge, entry.env);
    const indexPath = relativize(facts.indexPath);
    return {
      name: entry.name,
      env: entry.env,
      indexPath,
      indexDimension: facts.indexDimension,
      configuredDimension: facts.configuredDimension,
      dimension: facts.dimension,
      dimensionSource: facts.dimensionSource,
      model: facts.model,
      modelSource: facts.modelSource,
      providerConfigured: facts.providerConfigured,
      dimensionMismatch: facts.dimensionMismatch,
      mode: facts.mode,
      verdict: facts.verdict,
      dimensionRemedy: relativizeRemedy(facts.dimensionRemedy, facts.indexPath, indexPath),
    };
  });

  const fixture = buildFixture(manifest, cases);
  const mirror = buildMirror(manifest);

  if (check) {
    const problems: string[] = [];
    for (const [label, path, expected] of [
      ['fixture', FIXTURE, fixture],
      ['mirror', MIRROR, mirror],
    ] as const) {
      if (!existsSync(path)) {
        problems.push(`${label} ${path} does not exist`);
        continue;
      }
      if (readFileSync(path, 'utf8') !== expected) {
        problems.push(`${label} ${path} is stale`);
      }
    }
    if (problems.length > 0) {
      console.error('embed profile contract gate FAILED\n');
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('');
      console.error('  Run: npm run -s ops:sync-embed-profile-contract');
      return 1;
    }
    console.log(
      `[embed-profile-contract] OK (${cases.length} cases, mirror in sync with the Rust owner)`,
    );
    return 0;
  }

  mkdirSync(dirname(resolve(FIXTURE)), { recursive: true });
  writeFileSync(FIXTURE, fixture, 'utf8');
  writeFileSync(MIRROR, mirror, 'utf8');
  console.log(
    `[embed-profile-contract] wrote ${FIXTURE} and ${MIRROR} (${cases.length} cases, bridge ${bridgePath})`,
  );
  return 0;
}

process.exit(main());
