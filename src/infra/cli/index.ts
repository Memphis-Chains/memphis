/* eslint-disable no-restricted-syntax */
//
// CLI entry point. Reads + writes process.env to mirror CLI flags
// (--safe-mode → MEMPHIS_SAFE_MODE, --debug → LOG_LEVEL=debug, etc.)
// before any other module loads. This is the canonical write site
// for env-from-args. Sprint ι.3: file-level disable; downstream code
// still reads via env-registry typed accessors.
//
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeCommand } from './dispatcher.js';
import { parseCommand } from './parser.js';
import { checkDependencies } from './utils/dependencies.js';
import { LOG_LEVEL, NODE_ENV } from '../../config/env-registry.js';
import { ensureDir, getDataDir } from '../../config/paths.js';
import { formatCliError, toAppError } from '../../core/errors.js';
import { loadDotEnvFromInstallRoot } from '../config/env.js';
import { resolveVaultSecrets } from '../config/vault-resolve.js';
import { resolveExitCode } from '../runtime/exit-codes.js';
import { healAllSensitiveFiles } from '../storage/secure-file.js';

const FIRST_RUN_MARKER = resolve(getDataDir(), '.first-run-checks');

async function runFirstRunDependencyChecks(): Promise<void> {
  if (NODE_ENV.read(process.env) === 'test' || process.env.MEMPHIS_SKIP_FIRST_RUN_CHECKS === '1') return;
  if (existsSync(FIRST_RUN_MARKER)) return;

  const checks = await checkDependencies({ rawEnv: process.env });
  const failed = checks.filter((check) => check.required && !check.ok);

  ensureDir(getDataDir());
  writeFileSync(FIRST_RUN_MARKER, new Date().toISOString(), 'utf8');

  if (failed.length > 0) {
    const summary = failed
      .map((check) => `${check.title}: ${check.fix ?? check.detail}`)
      .join('; ');
    console.warn(`[doctor] First-run dependency issues detected. ${summary}`);
  }
}

function withSafeProcessArgv(argv: string[]): () => void {
  if (Array.isArray(process.argv)) {
    return () => undefined;
  }

  const fallbackArgv = argv.length > 0 ? [...argv] : [process.execPath ?? 'node', 'memphis'];
  (process as unknown as { argv?: string[] }).argv = fallbackArgv;

  return () => {
    (process as unknown as { argv?: string[] }).argv = undefined;
  };
}

export async function runCli(argv: string[] = process.argv ?? []): Promise<void> {
  const normalizedArgv = argv.length > 0 ? argv : [process.execPath ?? 'node', 'memphis'];
  const restoreProcessArgv = withSafeProcessArgv(normalizedArgv);

  try {
    const args = parseCommand(normalizedArgv);

    if (args.safeMode) {
      process.env.MEMPHIS_SAFE_MODE = 'true';
    }
    if (args.strictMode) {
      process.env.MEMPHIS_STRICT_MODE = 'true';
    }
    if (typeof args.faultInject === 'string' && args.faultInject.trim().length > 0) {
      process.env.MEMPHIS_FAULT_INJECT = args.faultInject.trim();
    }

    if (args.verbose) {
      process.env.LOG_LEVEL = 'debug';
    }

    // Load .env from install root BEFORE vault resolution and any
    // handler dispatch. Previously dotenv loading was tied to
    // loadConfig() which only fired for handlers that touched
    // context.getConfig() / getContainer(); handlers like
    // `memphis vault pepper-rotate` read process.env directly via
    // env-registry accessors and saw an empty MEMPHIS_VAULT_PEPPER
    // because no module on the dispatch path triggered the loader.
    // Operator session 2026-05-09 hit exactly this: the pepper-rotate
    // command prompted "Current pepper" instead of using the .env
    // value, blocking rotation for operators who don't keep the
    // pepper in their shell environment. Loading once here means
    // every CLI handler — incl. ones that bypass loadConfig — sees
    // the resolved .env values.
    //
    // Failure-tolerant: missing .env (fresh install / containerised
    // env-only setup) returns null from the loader; CLI continues
    // with whatever process.env was injected from the parent shell.
    try {
      loadDotEnvFromInstallRoot(process.env);
    } catch {
      // Best-effort: parse / permission failure shouldn't crash the CLI.
      // The loader itself logs a warn to stderr in that case.
    }

    // Eagerly resolve VAULT:<key> references in process.env before any
    // handler runs. Previously vault-resolve happened lazily via
    // loadConfig() which only fired for handlers that touched
    // context.getConfig() / getContainer(). Handlers like
    // `memphis telegram status` read process.env directly and saw the
    // unresolved literal `VAULT:telegram_bot_token` — telegram-readiness
    // detected the literal and reported `Token: missing` even though the
    // vault entry existed and other commands resolved it fine. The
    // 2026-04-29 operator smoke session hit exactly this. Doing the
    // resolution here once means every CLI handler sees the same
    // resolved env regardless of which paths it touches downstream.
    try {
      resolveVaultSecrets(process.env);
    } catch {
      // Vault not initialized yet (e.g. fresh install before
      // `memphis init`) — fall through silently. Subsequent handlers
      // that actually need vault secrets will surface a more specific
      // error than crashing the CLI on every command.
    }

    // Heal-on-load for sensitive files. This catches existing operator
    // installs where `vault-entries.json` (and any of the closed set
    // listed in healAllSensitiveFiles) still has 664 perms on disk
    // even though the writers now enforce 0600. Without this proactive
    // call the heal only fires when a specific vault subcommand
    // (`vault list/get/add/migrate`) lazily reads the file — operator's
    // 2026-04-30 smoke after #275 left vault-entries.json at 664 because
    // `service restart` doesn't trigger a vault-entries read.
    try {
      healAllSensitiveFiles(process.env);
    } catch {
      // Best-effort — never block a CLI command on a failed permission tighten.
    }

    if (args.command !== 'doctor' && args.command !== 'repair') {
      await runFirstRunDependencyChecks();
    }

    await executeCommand(normalizedArgv, args);
  } finally {
    restoreProcessArgv();
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = fileURLToPath(import.meta.url);

// Global error handlers to prevent silent crashes
process.on('uncaughtException', (error: Error) => {
  console.error(`[memphis] uncaught exception: ${error.message}`);
  if (LOG_LEVEL.read(process.env) === 'debug') {
    console.error(error.stack);
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`[memphis] unhandled rejection: ${message}`);
  if (LOG_LEVEL.read(process.env) === 'debug' && reason instanceof Error) {
    console.error(reason.stack);
  }
  process.exit(1);
});

if (entryPath === modulePath) {
  runCli().catch((error) => {
    const exitCode = resolveExitCode(error);
    if (exitCode !== 1) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(exitCode);
    }
    const verbose = process.argv?.includes('--verbose') ?? false;
    const appError = toAppError(error);
    console.error(formatCliError(error, { verbose }));
    process.exit(appError.statusCode >= 500 ? 4 : 2);
  });
}
