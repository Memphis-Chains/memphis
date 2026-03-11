import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { executeCommand } from './dispatcher.js';
import { parseCommand } from './parser.js';
import { formatCliError, toAppError } from '../../core/errors.js';
import { checkDependencies } from './utils/dependencies.js';

const FIRST_RUN_MARKER = resolve(homedir(), '.memphis', '.first-run-checks');

async function runFirstRunDependencyChecks(): Promise<void> {
  if (process.env.NODE_ENV === 'test' || process.env.MEMPHIS_SKIP_FIRST_RUN_CHECKS === '1') return;
  if (existsSync(FIRST_RUN_MARKER)) return;

  const checks = await checkDependencies({ rawEnv: process.env });
  const failed = checks.filter((check) => check.required && !check.ok);

  mkdirSync(resolve(homedir(), '.memphis'), { recursive: true });
  writeFileSync(FIRST_RUN_MARKER, new Date().toISOString(), 'utf8');

  if (failed.length > 0) {
    const summary = failed.map((check) => `${check.title}: ${check.fix ?? check.detail}`).join('; ');
    console.warn(`[doctor] First-run dependency issues detected. ${summary}`);
  }
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = parseCommand(argv);

  if (args.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  if (args.command !== 'doctor') {
    await runFirstRunDependencyChecks();
  }

  await executeCommand(argv, args);
}

runCli().catch((error) => {
  const verbose = process.argv.includes('--verbose');
  const appError = toAppError(error);
  console.error(formatCliError(error, { verbose }));
  process.exit(appError.statusCode >= 500 ? 4 : 2);
});
