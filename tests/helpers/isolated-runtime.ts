import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Give each test file its own config and persistent state before app imports. */
export function createIsolatedTestRuntime(parent: NodeJS.ProcessEnv, repoRoot: string) {
  const root = mkdtempSync(join(tmpdir(), 'memphis-vitest-'));
  const data = join(root, 'data');
  mkdirSync(data, { mode: 0o700 });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@memphis-chains/memphis' }));
  writeFileSync(join(root, '.env'), '', { mode: 0o600 });

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
  Object.assign(env, {
    NODE_ENV: 'test',
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
