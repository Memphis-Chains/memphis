import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../..');
const tsxPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const cliPath = resolve(repoRoot, 'src/infra/cli/index.ts');

type CliOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function spawnCli(
  args: string[],
  options: CliOptions = {},
): ReturnType<typeof spawnSync> {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
      ...(options.env ?? {}),
    },
  };

  return spawnSync(process.execPath, [tsxPath, cliPath, ...args], spawnOptions);
}

export function runCli(args: string[], options?: CliOptions): string {
  const result = spawnCli(args, options);
  if (result.status === 0) {
    return result.stdout;
  }

  const message = result.stderr || result.stdout || `CLI exited with code ${String(result.status)}`;
  throw new Error(message);
}

export function runCliResult(args: string[], options?: CliOptions): ReturnType<typeof spawnCli> {
  return spawnCli(args, options);
}
