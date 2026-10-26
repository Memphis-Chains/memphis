import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Apply `source` onto `target` IN PLACE, instead of replacing the object.
 *
 * `process.env` is a special object: assigning to a key on it calls
 * `setenv` in the process environment, and `os.homedir()` reads that
 * environment. Replacing the whole object (`process.env = {...}`) turns it
 * into a plain object, where assignments no longer reach the process
 * environment — so `os.homedir()` keeps returning the operator's real home
 * no matter what `HOME` says.
 *
 * That split state is not cosmetic. It is how a test run appended fixture
 * blocks to the operator's LIVE journal chain (2026-10-24): the chain
 * adapter resolved `~` through `os.homedir()` and landed in the real data
 * directory while the test's own `process.env` pointed somewhere else. It
 * is also why the sandbox tests lost their temporary home.
 */
export function applyEnvInPlace(target: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      delete target[key];
      continue;
    }
    target[key] = value;
  }
}

/** Give each test file its own config and persistent state before app imports. */
export function createIsolatedTestRuntime(parent: NodeJS.ProcessEnv, repoRoot: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memphis-vitest-')));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@memphis-chains/memphis' }));
  writeFileSync(join(root, '.env'), '', { mode: 0o600 });

  // A controlled first-run state, so the commands that require an initialized
  // runtime (chat / ask / ask-session / tui) actually run.
  //
  // Why this exists: before the test runtime was isolated, those commands
  // inherited the operator's OWN initialized `~/.memphis` through the process
  // environment, so they passed their gates for the wrong reason. With an
  // isolated data directory they had nothing to read, and every CLI test
  // failed with NOT_INITIALIZED — a test that only passed because it was
  // reading the operator's live runtime state.
  //
  // The state written here mirrors what `memphis init` leaves behind: a
  // first-run record with the current schema version. No chains are created,
  // so the legacy-chain scan stays clean and the runtime reports
  // `initialized-clean`.
  const configDir = join(data, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(configDir, 'first-run.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        initializedAt: new Date().toISOString(),
        mode: 'minimal-baseline',
        createdChains: [],
        createdBlocks: 0,
        summary: 'Isolated test runtime.',
        origin: 'controlled-init',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const env = { ...parent };
  // A shell or service may have loaded the real dotenv before launching Vitest.
  // Keep host credentials, paths and destructive force flags out of workers.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith('MEMPHIS_') ||
      key.startsWith('RUST_CHAIN_') ||
      key.startsWith('RUST_EMBED_') ||
      /(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD|PASSPHRASE)$/.test(key)
    ) {
      delete env[key];
    }
  }
  // `OPENAI_AUTH_MODE=codex` adds the OpenAI provider to the runtime
  // registry. Inherited from the operator's own `.env`, it made the set of
  // registered providers — and therefore the order of `providers:health`
  // output — depend on the machine the suite ran on. A test that changes
  // with the developer's configuration is not a test.
  delete env.OPENAI_AUTH_MODE;
  Object.assign(env, {
    NODE_ENV: 'test',
    // Keep installed Rust toolchains discoverable when HOME moves into the
    // fixture. CI rustup shims otherwise search the empty isolated home.
    ...(parent.HOME
      ? {
          CARGO_HOME: parent.CARGO_HOME ?? join(parent.HOME, '.cargo'),
          RUSTUP_HOME: parent.RUSTUP_HOME ?? join(parent.HOME, '.rustup'),
        }
      : {}),
    // HOME follows the isolated root, so `os.homedir()` — which reads the
    // process environment, not the `process.env` object — resolves inside
    // the sandbox instead of the operator's real home directory.
    HOME: root,
    MEMPHIS_RUNTIME_ROOT: root,
    MEMPHIS_ENV_FILE: join(root, '.env'),
    MEMPHIS_HOME: data,
    MEMPHIS_DATA_DIR: data,
    MEMPHIS_VAULT_STATE_PATH: join(data, 'vault-state.json'),
    MEMPHIS_VAULT_ENTRIES_PATH: join(data, 'vault-entries.json'),
    MEMPHIS_SECURITY_AUDIT_LOG_PATH: join(data, 'security-audit.jsonl'),
    MEMPHIS_LOG_FILE: join(data, 'memphis.log'),
    MEMPHIS_QUEUE_WAL_PATH: join(data, 'queue.wal'),
    DATABASE_URL: `file:${join(data, 'memphis.db')}`,
    RUST_CHAIN_ENABLED: 'true',
    RUST_CHAIN_BRIDGE_PATH:
      parent.MEMPHIS_TEST_NATIVE_BRIDGE ?? join(repoRoot, 'crates', 'memphis-napi'),
    RUST_EMBED_PERSIST_PATH: join(data, 'embed-index.json'),
    MEMPHIS_API_TOKEN: '',
    MEMPHIS_RATE_LIMIT_SENSITIVE_MAX: '10',
    MEMPHIS_RATE_LIMIT_GLOBAL_MAX: '100',
    MEMPHIS_SLO_TURN_P99_MS: '3000',
    MEMPHIS_SLO_ERROR_RATE_MAX: '0.05',
    MEMPHIS_SURFACE_TELEGRAM_DEFAULT_CONSENT: 'local-only',
    MEMPHIS_DEFAULT_CONSENT: 'local-only',
  });
  for (const key of [
    'MEMPHIS_STRICT_VITEST_RACE',
    'MEMPHIS_QUIET_TEST_LOGS',
    'MEMPHIS_TEST_NATIVE_BRIDGE',
  ]) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return { root, env };
}
