import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { executeCommand } from './dispatcher.js';
import { parseCommand } from './parser.js';
import { checkDependencies } from './utils/dependencies.js';
import { ensureDir, getDataDir } from '../../config/paths.js';
import { formatCliError, toAppError } from '../../core/errors.js';
import { resolveExitCode } from '../runtime/exit-codes.js';

const FIRST_RUN_MARKER = resolve(getDataDir(), '.first-run-checks');

async function runFirstRunDependencyChecks(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.MEMPHIS_SKIP_FIRST_RUN_CHECKS === '1') return;
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

export async function runCli(argv: string[] = process.argv ?? []): Promise<void> {
  const args = parseCommand(argv);

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

  if (args.command !== 'doctor') {
    await runFirstRunDependencyChecks();
  }

  await executeCommand(argv, args);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
const modulePath = fileURLToPath(import.meta.url);

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
