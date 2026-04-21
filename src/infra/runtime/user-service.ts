import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { resolveInstallRoot } from './install-root.js';

export type UserServiceStatus = {
  name: string;
  available: boolean;
  installed: boolean;
  enabled: boolean;
  active: boolean;
  unitPath: string;
  runtimeRoot: string;
  execStart: string;
  pathEnv: string;
  detail: string;
};

export type UserServiceLogs = {
  name: string;
  latest: number;
  output: string;
};

export type UserServiceInstallResult = UserServiceStatus & {
  written: boolean;
  lingerEnabled: boolean;
};

export type UserServiceUninstallResult = {
  name: string;
  available: boolean;
  removed: boolean;
  unitPath: string;
  detail: string;
};

type CommandRunner = (command: string, args: string[]) => SpawnSyncReturns<string>;

const SERVICE_NAME = 'memphis.service';
const MEMPHIS_PACKAGE_NAME = '@memphis-chains/memphis';

function defaultRunner(command: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function parsePackageName(root: string): string | null {
  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: string };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}

export function resolveRuntimeRoot(cwd = process.cwd()): string {
  // Keep the explicit-cwd-matches path first so unit tests + callers that
  // know where they are still short-circuit without touching disk.
  const root = resolve(cwd);
  if (parsePackageName(root) === MEMPHIS_PACKAGE_NAME) {
    return root;
  }
  // Fall through to install-root discovery: env override → walk-up from
  // the CLI binary path (realpath-resolves `npm link` symlinks) → walk-up
  // from cwd. This is what makes `memphis tui` / `memphis self-update`
  // work from anywhere, not just `~/memphis/`.
  try {
    return resolveInstallRoot({ cwd });
  } catch {
    throw new Error(
      'run this command from the Memphis runtime root (directory with package.json), or set MEMPHIS_RUNTIME_ROOT=<path>',
    );
  }
}

function nodeBinPath(): string {
  return process.execPath;
}

function buildPathEnv(): string {
  const nodeDir = dirname(nodeBinPath());
  return `${nodeDir}:${process.env.HOME ?? ''}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}

export function resolveServiceExecStart(runtimeRoot: string): string {
  const distServeEntry = join(runtimeRoot, 'dist/infra/cli/index.js');
  if (existsSync(distServeEntry)) {
    return `${nodeBinPath()} ${distServeEntry} serve`;
  }

  const sourceEntry = join(runtimeRoot, 'src/index.ts');
  if (existsSync(sourceEntry)) {
    const npmPath = spawnSync('bash', ['-lc', 'command -v npm'], { encoding: 'utf8' });
    const npmBin = npmPath.status === 0 ? npmPath.stdout.trim() : '';
    if (npmBin.length > 0) {
      return `${npmBin} run dev`;
    }
  }

  throw new Error('could not resolve Memphis runtime entrypoint for service installation');
}

export function getUserServicePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const configHome = rawEnv.XDG_CONFIG_HOME?.trim() || join(rawEnv.HOME ?? '', '.config');
  return join(configHome, 'systemd/user', SERVICE_NAME);
}

export function buildUserServiceUnit(
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string {
  const execStart = resolveServiceExecStart(runtimeRoot);
  const pathEnv = buildPathEnv();
  const nodeEnv = rawEnv.NODE_ENV?.trim() || 'development';
  const home = rawEnv.HOME ?? '';

  const envFile = rawEnv.MEMPHIS_ENV_FILE ?? join(runtimeRoot, '.env');

  return [
    '[Unit]',
    'Description=Memphis local runtime',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${runtimeRoot}`,
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    'RestartPreventExitStatus=101 102 103',
    `EnvironmentFile=${envFile}`,
    `Environment=HOME=${home}`,
    `Environment=NODE_ENV=${nodeEnv}`,
    `Environment=PATH=${pathEnv}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function systemdUserAvailable(runner: CommandRunner = defaultRunner): boolean {
  const result = runner('systemctl', ['--user', 'show-environment']);
  return result.status === 0;
}

function systemctlOk(runner: CommandRunner, ...args: string[]): boolean {
  const result = runner('systemctl', ['--user', ...args]);
  return result.status === 0;
}

export function getUserServiceStatus(
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
): UserServiceStatus {
  const unitPath = getUserServicePath(rawEnv);
  const installed = existsSync(unitPath);
  const available = systemdUserAvailable(runner);
  const active = available && systemctlOk(runner, 'is-active', '--quiet', SERVICE_NAME);
  const enabled = available && systemctlOk(runner, 'is-enabled', '--quiet', SERVICE_NAME);
  const execStart = installed ? resolveServiceExecStart(runtimeRoot) : 'not installed';
  const pathEnv = buildPathEnv();

  return {
    name: SERVICE_NAME,
    available,
    installed,
    enabled,
    active,
    unitPath,
    runtimeRoot,
    execStart,
    pathEnv,
    detail: !available
      ? 'systemd --user unavailable'
      : !installed
        ? 'service unit not installed'
        : active
          ? 'installed and active'
          : enabled
            ? 'installed and enabled, but not active'
            : 'installed but disabled',
  };
}

export function installUserService(
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
): UserServiceInstallResult {
  if (!systemdUserAvailable(runner)) {
    throw new Error('systemd --user unavailable on this host');
  }

  const unitPath = getUserServicePath(rawEnv);
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, buildUserServiceUnit(runtimeRoot, rawEnv), 'utf8');

  if (!systemctlOk(runner, 'daemon-reload')) {
    throw new Error('systemctl --user daemon-reload failed');
  }
  if (!systemctlOk(runner, 'enable', '--now', SERVICE_NAME)) {
    throw new Error(`failed to enable/start ${SERVICE_NAME}`);
  }

  let lingerEnabled = false;
  const user = rawEnv.USER?.trim();
  if (user) {
    const linger = runner('loginctl', ['enable-linger', user]);
    lingerEnabled = linger.status === 0;
  }

  return {
    ...getUserServiceStatus(runtimeRoot, rawEnv, runner),
    written: true,
    lingerEnabled,
  };
}

export function restartUserService(
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
): UserServiceStatus {
  if (!systemdUserAvailable(runner)) {
    throw new Error('systemd --user unavailable on this host');
  }
  if (!systemctlOk(runner, 'restart', SERVICE_NAME)) {
    throw new Error(`failed to restart ${SERVICE_NAME}`);
  }
  return getUserServiceStatus(runtimeRoot, rawEnv, runner);
}

export function readUserServiceLogs(
  latest = 100,
  runner: CommandRunner = defaultRunner,
): UserServiceLogs {
  if (!systemdUserAvailable(runner)) {
    throw new Error('systemd --user unavailable on this host');
  }

  const result = runner('journalctl', [
    '--user',
    '-u',
    SERVICE_NAME,
    '-n',
    String(latest),
    '--no-pager',
  ]);
  if (result.status !== 0) {
    throw new Error(`failed to read logs for ${SERVICE_NAME}`);
  }

  return {
    name: SERVICE_NAME,
    latest,
    output: result.stdout.trim(),
  };
}

export function uninstallUserService(
  rawEnv: NodeJS.ProcessEnv = process.env,
  runner: CommandRunner = defaultRunner,
): UserServiceUninstallResult {
  const unitPath = getUserServicePath(rawEnv);
  const available = systemdUserAvailable(runner);

  if (available) {
    runner('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
    runner('systemctl', ['--user', 'stop', SERVICE_NAME]);
  }

  const existed = existsSync(unitPath);
  rmSync(unitPath, { force: true });

  if (available) {
    runner('systemctl', ['--user', 'daemon-reload']);
    runner('systemctl', ['--user', 'reset-failed', SERVICE_NAME]);
  }

  return {
    name: SERVICE_NAME,
    available,
    removed: existed,
    unitPath,
    detail: existed ? 'service unit removed' : 'service unit not present',
  };
}
