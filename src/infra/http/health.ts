import { accessSync, constants, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';

export type HealthCheckStatus = 'ok' | 'fail';

type CheckResult = {
  status: HealthCheckStatus;
  message?: string;
  latency_ms?: number;
};

export type HealthPayload = {
  status: 'healthy' | 'unhealthy';
  checks: {
    database: CheckResult;
    rust_bridge: CheckResult;
    data_dir: CheckResult;
    embedding_provider: CheckResult;
  };
  version: string;
  uptime_seconds: number;
};

function appVersion(): string {
  return process.env.npm_package_version ?? '0.1.3';
}

function resolveSqlitePath(databaseUrl: string): string | null {
  if (!databaseUrl.startsWith('file:')) return null;
  return databaseUrl.replace(/^file:/, '');
}

function checkDatabase(databaseUrl: string): CheckResult {
  const dbPath = resolveSqlitePath(databaseUrl);
  if (!dbPath) {
    return { status: 'fail', message: 'DATABASE_URL must use file: scheme' };
  }

  const absoluteDbPath = resolve(dbPath);
  if (!existsSync(absoluteDbPath)) {
    return { status: 'fail', message: 'database file does not exist' };
  }

  try {
    accessSync(absoluteDbPath, constants.W_OK);
    accessSync(dirname(absoluteDbPath), constants.W_OK);
    return { status: 'ok' };
  } catch {
    return { status: 'fail', message: 'database file or directory is not writable' };
  }
}

function checkDataDir(rawEnv: NodeJS.ProcessEnv): CheckResult {
  const dataDir = resolve(rawEnv.MEMPHIS_DATA_DIR ?? 'data');
  if (!existsSync(dataDir)) {
    return { status: 'fail', message: 'data directory does not exist' };
  }

  try {
    accessSync(dataDir, constants.W_OK);
    return { status: 'ok' };
  } catch {
    return { status: 'fail', message: 'data directory is not writable' };
  }
}

function checkRustBridge(rawEnv: NodeJS.ProcessEnv): CheckResult {
  const status = getRustEmbedAdapterStatus(rawEnv);
  if (!status.rustEnabled) {
    return { status: 'ok', message: 'rust bridge disabled' };
  }

  if (status.bridgeLoaded && status.embedApiAvailable) {
    return { status: 'ok' };
  }

  return { status: 'fail', message: 'rust bridge unavailable' };
}

async function checkEmbeddingProvider(rawEnv: NodeJS.ProcessEnv): Promise<CheckResult> {
  const mode = rawEnv.RUST_EMBED_MODE ?? 'local';
  let endpoint: string | undefined;

  if (mode === 'ollama') endpoint = 'http://127.0.0.1:11434/api/tags';
  if (mode === 'provider' || mode === 'openai-compatible') {
    endpoint = rawEnv.RUST_EMBED_PROVIDER_URL;
  }

  if (!endpoint) {
    return { status: 'ok', message: `mode=${mode} (no ping required)` };
  }

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: AbortSignal.timeout(350),
    });
    const latency_ms = Date.now() - startedAt;
    if (response.ok || response.status < 500) {
      return { status: 'ok', latency_ms };
    }
    return { status: 'fail', message: `provider returned ${response.status}`, latency_ms };
  } catch {
    return { status: 'fail', message: 'provider ping failed', latency_ms: Date.now() - startedAt };
  }
}

export async function buildHealthPayload(config: AppConfig, rawEnv: NodeJS.ProcessEnv = process.env): Promise<HealthPayload> {
  const checks = {
    database: checkDatabase(config.DATABASE_URL),
    rust_bridge: checkRustBridge(rawEnv),
    data_dir: checkDataDir(rawEnv),
    embedding_provider: await checkEmbeddingProvider(rawEnv),
  };

  const requiredHealthy = checks.database.status === 'ok' && checks.rust_bridge.status === 'ok' && checks.data_dir.status === 'ok';

  return {
    status: requiredHealthy ? 'healthy' : 'unhealthy',
    checks,
    version: appVersion(),
    uptime_seconds: Math.floor(process.uptime()),
  };
}
