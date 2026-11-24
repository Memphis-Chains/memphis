/**
 * The TypeScript arm of the embed-profile contract, checked against the
 * fixture the native arm also reads.
 *
 * `tests/fixtures/embed-profile-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/embed_profile_contract.rs`.
 *
 * ## Why this test exists
 *
 * "Which embedding profile is in force?" had FOUR owners on this host and
 * FOUR answers:
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
 * The `32` was never an embedding dimension. It is `DEFAULT_EMBEDDING_DIM` —
 * the width of the LOCAL DETERMINISTIC embedder, the placeholder used when
 * no provider is configured — and the configuration builder applied it
 * unconditionally.
 *
 * MEASURED 2026-11-23 on the operator's host: the service answered
 * `mode: semantic` with dim 1024, while a shell, the CLI and any spawned
 * script answered dim 32 against an index that holds 768.
 *
 * The fix is ONE owner (`crates/memphis-embed/src/profile.rs`), ONE
 * artefact of cases, and TWO runners. Neither arm produces the artefact
 * alone, so neither can change it alone.
 *
 * ## What this arm checks
 *
 * 1. The MIRROR (`src/infra/storage/embed-profile.generated.ts`) publishes
 *    the vocabulary the contract records — the environment names, the
 *    dimension sources, the verdicts, the provider names, the local width.
 * 2. The OWNER answers every case the way the contract says, asked
 *    through the bridge — the same way the surfaces ask.
 * 3. The TypeScript surfaces do NOT carry their own copy of the rule: no
 *    surface may name the embed dimension itself, and the mode vocabulary
 *    may only come from the mirror.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EMBED_PROFILE_DIMENSION_SOURCES,
  EMBED_PROFILE_ENV,
  EMBED_PROFILE_LOCAL_DIMENSION,
  EMBED_PROFILE_LOCAL_MODE,
  EMBED_PROFILE_PROVIDER_ALIAS,
  EMBED_PROFILE_PROVIDER_MODES,
  EMBED_PROFILE_VERDICTS,
} from '../../src/infra/storage/embed-profile.generated.js';
import { bridgeEmbedProfileFacts } from '../../src/infra/storage/rust-embed-profile-bridge.js';

interface ContractCase {
  name: string;
  env: Record<string, string>;
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
  dimensionRemedy: string | null;
}

interface ContractManifest {
  schemaVersion: number;
  env: { indexPath: string; dimension: string; model: string; mode: string };
  defaults: { indexPath: string; dimension: string; model: string; localDimension: number };
  dimensionSources: string[];
  verdicts: string[];
  modes: { local: string; alias: string; providers: string[] };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'embed-profile-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  manifest: ContractManifest;
  cases: ContractCase[];
};

/** The owner's answer, in the root-relative form the artefact records. */
function relativize(absolutePath: string): string {
  const relative = path.relative(REPO_ROOT, absolutePath);
  if (!relative || relative.startsWith('..')) return absolutePath;
  return relative;
}

/**
 * The source of a file, with the comments removed.
 *
 * The guard below looks for a hard-coded dimension in CODE. A comment that
 * mentions "32" — which is how the story of the old default is told — must
 * not trip it.
 */
function codeOnly(relativePath: string): string {
  const source = readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

describe('the embed-profile contract — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it('publishes the environment names the contract records', () => {
    expect(EMBED_PROFILE_ENV.indexPath).toBe(fixture.manifest.env.indexPath);
    expect(EMBED_PROFILE_ENV.dimension).toBe(fixture.manifest.env.dimension);
    expect(EMBED_PROFILE_ENV.model).toBe(fixture.manifest.env.model);
    expect(EMBED_PROFILE_ENV.mode).toBe(fixture.manifest.env.mode);
  });

  it('publishes the dimension sources and the verdicts the contract records', () => {
    expect([...EMBED_PROFILE_DIMENSION_SOURCES]).toEqual(fixture.manifest.dimensionSources);
    expect([...EMBED_PROFILE_VERDICTS]).toEqual(fixture.manifest.verdicts);
  });

  it('publishes the mode vocabulary the contract records', () => {
    expect(EMBED_PROFILE_LOCAL_MODE).toBe(fixture.manifest.modes.local);
    expect(EMBED_PROFILE_PROVIDER_ALIAS).toBe(fixture.manifest.modes.alias);
    expect([...EMBED_PROFILE_PROVIDER_MODES]).toEqual(fixture.manifest.modes.providers);
  });

  it('publishes the local width the contract records', () => {
    expect(EMBED_PROFILE_LOCAL_DIMENSION).toBe(fixture.manifest.defaults.localDimension);
  });

  it('resolves every case the way the contract says', () => {
    for (const testCase of fixture.cases) {
      const facts = bridgeEmbedProfileFacts(testCase.env as NodeJS.ProcessEnv);

      expect(relativize(facts.indexPath), testCase.name).toBe(testCase.indexPath);
      expect(facts.indexDimension, testCase.name).toBe(testCase.indexDimension);
      expect(facts.configuredDimension, testCase.name).toBe(testCase.configuredDimension);
      expect(facts.dimension, testCase.name).toBe(testCase.dimension);
      expect(facts.dimensionSource, testCase.name).toBe(testCase.dimensionSource);
      expect(facts.model, testCase.name).toBe(testCase.model);
      expect(facts.modelSource, testCase.name).toBe(testCase.modelSource);
      expect(facts.providerConfigured, testCase.name).toBe(testCase.providerConfigured);
      expect(facts.dimensionMismatch, testCase.name).toBe(testCase.dimensionMismatch);
      expect(facts.mode, testCase.name).toBe(testCase.mode);
      expect(facts.verdict, testCase.name).toBe(testCase.verdict);
    }
  });

  it('gives the dimension disagreement its own remedy', () => {
    const mismatch = fixture.cases.find((entry) => entry.dimensionMismatch);
    expect(mismatch, 'the corpus must hold a mismatching case').toBeDefined();
    expect(mismatch?.dimensionRemedy).toContain('RUST_EMBED_DIM=');
  });
});

describe('the embed-profile contract — the TypeScript side keeps no copy of the rule', () => {
  const SURFACES = [
    'src/infra/tensors/status.ts',
    'src/infra/http/health.ts',
    'src/infra/config/schema.ts',
    'src/infra/cli/commands/setup.ts',
    'src/infra/cli/onboarding-wizard.ts',
    'src/infra/runtime/embedding-metadata.ts',
    'src/infra/operator-guide.ts',
  ];

  it('never names the embed dimension itself', () => {
    for (const file of SURFACES) {
      const code = codeOnly(file);
      // `RUST_EMBED_DIM` ASSIGNED a literal number is this side deciding
      // the dimension. The number is the owner's business.
      expect(code, file).not.toMatch(/RUST_EMBED_DIM\s*[:=]\s*['"`]?\d+/);
      // A dimension pinned as a default value.
      expect(code, file).not.toMatch(/RUST_EMBED_DIM[^;\n]*default\(\s*\d+\s*\)/);
      // A width used as a default argument, whatever the variable is called.
      expect(code, file).not.toMatch(/,\s*32\s*\)/);
    }
  });

  it('takes the mode vocabulary from the mirror, not from a hand-written list', () => {
    const code = codeOnly('src/infra/config/schema.ts');
    expect(code).toContain('EMBED_PROFILE_PROVIDER_MODES');
    expect(code).toContain('EMBED_PROFILE_PROVIDER_ALIAS');
    expect(code).toContain('EMBED_PROFILE_LOCAL_MODE');
    // The old hand-written enum named the same eleven words.
    expect(code).not.toMatch(/'openai-compatible'/);
  });
});
