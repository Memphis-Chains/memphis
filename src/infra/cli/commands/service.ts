import { readFileSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { getDataDir } from '../../../config/paths.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import {
  getUserServiceStatus,
  installUserService,
  readUserServiceLogs,
  resolveRuntimeRoot,
  restartUserService,
  uninstallUserService,
  type UserServiceInstallResult,
  type UserServiceLogs,
  type UserServiceStatus,
  type UserServiceUninstallResult,
} from '../../runtime/user-service.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type ServiceOps = {
  status: (runtimeRoot: string, rawEnv?: NodeJS.ProcessEnv) => UserServiceStatus;
  install: (runtimeRoot: string, rawEnv?: NodeJS.ProcessEnv) => UserServiceInstallResult;
  restart: (runtimeRoot: string, rawEnv?: NodeJS.ProcessEnv) => UserServiceStatus;
  uninstall: (rawEnv?: NodeJS.ProcessEnv) => UserServiceUninstallResult;
  logs: (latest?: number) => UserServiceLogs;
};

type ResetResult = {
  ok: boolean;
  runtimeRoot: string;
  removed: string[];
  skipped: string[];
  service: UserServiceUninstallResult;
};

const DEFAULT_SERVICE_OPS: ServiceOps = {
  status: (runtimeRoot, rawEnv) => getUserServiceStatus(runtimeRoot, rawEnv),
  install: (runtimeRoot, rawEnv) => installUserService(runtimeRoot, rawEnv),
  restart: (runtimeRoot, rawEnv) => restartUserService(runtimeRoot, rawEnv),
  uninstall: (rawEnv) => uninstallUserService(rawEnv),
  logs: (latest) => readUserServiceLogs(latest),
};

function printServiceUsage(json: boolean): void {
  print(
    {
      usage:
        'memphis service status|install|logs|restart|uninstall [--json] [--latest <n>] | memphis reset --runtime --yes [--json]',
    },
    json,
  );
}

function printServiceStatusHuman(result: UserServiceStatus): void {
  console.log(`service: ${result.name}`);
  console.log(`runtime root: ${result.runtimeRoot}`);
  console.log(`systemd user: ${result.available ? 'available' : 'unavailable'}`);
  console.log(`unit path: ${result.unitPath}`);
  console.log(`installed: ${result.installed ? 'yes' : 'no'}`);
  console.log(`enabled: ${result.enabled ? 'yes' : 'no'}`);
  console.log(`active: ${result.active ? 'yes' : 'no'}`);
  console.log(`exec start: ${result.execStart}`);
  console.log(`detail: ${result.detail}`);
}

function printServiceLogsHuman(result: UserServiceLogs): void {
  if (result.output.length === 0) {
    console.log(`No logs for ${result.name}`);
    return;
  }
  console.log(result.output);
}

function runtimeRootFromContext(): string {
  return resolveRuntimeRoot(process.cwd());
}

function parseDotEnv(envPath: string): Record<string, string> {
  if (!envPath) return {};
  try {
    const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
    const entries: Record<string, string> = {};
    for (const line of lines) {
      if (!line || line.trim().startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key.length > 0) entries[key] = value;
    }
    return entries;
  } catch {
    return {};
  }
}

function maybeRemove(path: string, removed: string[], skipped: string[]): void {
  try {
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  } catch {
    skipped.push(path);
  }
}

function resolveEnvPathTarget(raw: string, runtimeRoot: string): string | null {
  if (!raw.trim()) return null;
  if (raw.startsWith('file:')) {
    const filePath = raw.replace(/^file:/, '');
    return isAbsolute(filePath) ? filePath : resolve(runtimeRoot, filePath);
  }
  return isAbsolute(raw) ? raw : resolve(runtimeRoot, raw);
}

export function resetRuntimeState(
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  serviceOps: Pick<ServiceOps, 'uninstall'> = DEFAULT_SERVICE_OPS,
): ResetResult {
  const removed: string[] = [];
  const skipped: string[] = [];
  const envPath = resolve(runtimeRoot, '.env');
  const envFile = parseDotEnv(envPath);

  const service = serviceOps.uninstall(rawEnv);

  const targets = new Set<string>([
    getDataDir(rawEnv),
    resolve(runtimeRoot, '.env'),
    resolve(runtimeRoot, '.memphis'),
    resolve(runtimeRoot, 'AGENTS.md'),
    resolve(runtimeRoot, 'CLAUDE.md'),
    resolve(runtimeRoot, 'data/memphis.db'),
    resolve(runtimeRoot, 'data/memphis.db-shm'),
    resolve(runtimeRoot, 'data/memphis.db-wal'),
    resolve(runtimeRoot, 'data/embed-index.json'),
    resolve(runtimeRoot, 'memphis.db'),
    resolve(runtimeRoot, 'memphis.db-shm'),
    resolve(runtimeRoot, 'memphis.db-wal'),
    resolve(runtimeRoot, 'embed-index.json'),
    // Historical path bugs can leave chain debris under ./undefined/chains.
    resolve(runtimeRoot, 'undefined'),
  ]);

  const configuredDataDir = rawEnv.MEMPHIS_DATA_DIR?.trim() || envFile.MEMPHIS_DATA_DIR?.trim();
  if (configuredDataDir) {
    targets.add(resolveEnvPathTarget(configuredDataDir, runtimeRoot) ?? configuredDataDir);
  }

  const configuredDb = envFile.DATABASE_URL?.trim();
  if (configuredDb) {
    const resolved = resolveEnvPathTarget(configuredDb, runtimeRoot);
    if (resolved) targets.add(resolved);
  }

  const configuredEmbedPath = envFile.RUST_EMBED_PERSIST_PATH?.trim();
  if (configuredEmbedPath) {
    const resolved = resolveEnvPathTarget(configuredEmbedPath, runtimeRoot);
    if (resolved) targets.add(resolved);
  }

  for (const target of targets) {
    if (!target) continue;
    maybeRemove(target, removed, skipped);
  }

  return {
    ok: true,
    runtimeRoot,
    removed,
    skipped,
    service,
  };
}

export async function handleServiceCommand(
  context: CliContext,
  serviceOps: ServiceOps = DEFAULT_SERVICE_OPS,
): Promise<boolean> {
  const { command, subcommand, json, latest, yes, runtime } = context.args;

  if (command !== 'service' && command !== 'reset') return false;

  if (command === 'reset') {
    if (!runtime) {
      throw new Error('reset currently requires --runtime');
    }
    if (!yes) {
      throw new Error('reset requires --yes');
    }
    // S5-1: gate reset --runtime --yes — wipes vault state, chains,
    // and embeddings. Even with --yes intent flag, the operator
    // identity must be confirmed before destruction.
    if (!(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }
    const runtimeRoot = runtimeRootFromContext();
    const result = resetRuntimeState(runtimeRoot, process.env, serviceOps);
    if (json) {
      print(result, true);
    } else {
      console.log(`runtime reset complete: ${runtimeRoot}`);
      console.log(`service: ${result.service.detail}`);
      console.log(`removed: ${result.removed.length}`);
      for (const item of result.removed) console.log(`  - ${item}`);
      if (result.skipped.length > 0) {
        console.log(`skipped: ${result.skipped.length}`);
        for (const item of result.skipped) console.log(`  - ${item}`);
      }
    }
    return true;
  }

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printServiceUsage(json);
    return true;
  }

  // logs and uninstall don't need the runtime root
  if (subcommand === 'logs') {
    const result = serviceOps.logs(latest ?? 100);
    if (json) print(result, true);
    else printServiceLogsHuman(result);
    return true;
  }

  if (subcommand === 'uninstall') {
    const result = serviceOps.uninstall(process.env);
    if (json) print(result, true);
    else {
      console.log(`service: ${result.name}`);
      console.log(`unit path: ${result.unitPath}`);
      console.log(`detail: ${result.detail}`);
    }
    return true;
  }

  const runtimeRoot = runtimeRootFromContext();

  if (subcommand === 'status') {
    const result = serviceOps.status(runtimeRoot, process.env);
    if (json) print(result, true);
    else printServiceStatusHuman(result);
    return true;
  }

  if (subcommand === 'install') {
    const result = serviceOps.install(runtimeRoot, process.env);
    if (json) print(result, true);
    else printServiceStatusHuman(result);
    return true;
  }

  if (subcommand === 'restart') {
    const result = serviceOps.restart(runtimeRoot, process.env);
    if (json) print(result, true);
    else printServiceStatusHuman(result);
    return true;
  }

  throw new Error(`Unknown service subcommand: ${String(subcommand)}`);
}
