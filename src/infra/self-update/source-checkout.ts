/**
 * Source-checkout mode for `memphis self-update`.
 *
 * Detects a git checkout of the repo and runs:
 *
 *   1. dirty-tree guard (bail if uncommitted changes)
 *   2. `git fetch --quiet origin`
 *   3. if HEAD == origin/main → "up to date", return
 *   4. `git pull --ff-only`
 *   5. hash compare on package-lock.json → `npm install` only if changed
 *   6. `npm run build`
 *   7. `restartUserService` if the systemd unit is currently active
 *
 * This replaces the four-step manual flow operators running
 * source-checkout installs had been doing by hand. The existing tarball
 * `checkForUpdate` / `installUpdate` path remains unchanged for
 * release-tarball installs; the commands/self-update.ts dispatcher
 * routes at entry based on the result of `detectSourceCheckout`.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getUserServiceStatus,
  restartUserService,
} from '../runtime/user-service.js';

export type SourceRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => SpawnSyncReturns<string>;

const defaultRunner: SourceRunner = (command, args, options) =>
  spawnSync(command, args, { cwd: options?.cwd, encoding: 'utf8' });

export type SourceCheckoutDetection = {
  isSource: boolean;
  head?: string;
  branch?: string;
  remote?: string;
  reason?: string;
};

export type SourceCheckResult = {
  ok: boolean;
  mode: 'source-checkout';
  updateAvailable: boolean;
  currentCommit: string;
  latestCommit: string;
  commitsBehind: number;
  subjects: string[];
  remote: string;
  branch: string;
  error?: string;
};

export type SourceInstallOptions = {
  dryRun?: boolean;
  skipRestart?: boolean;
  skipBuild?: boolean;
  runner?: SourceRunner;
  rawEnv?: NodeJS.ProcessEnv;
};

export type SourceInstallResult = {
  ok: boolean;
  mode: 'source-checkout';
  dryRun: boolean;
  fromCommit: string;
  toCommit: string;
  commitsPulled: number;
  packageLockChanged: boolean;
  installed: boolean;
  built: boolean;
  serviceRestarted: boolean;
  durationMs: number;
  failedStage?: 'dirty-tree' | 'fetch' | 'pull' | 'install' | 'build' | 'restart';
  error?: string;
  warnings: string[];
};

function runGit(
  args: string[],
  runner: SourceRunner,
  cwd: string,
): { stdout: string; stderr: string; status: number } {
  const result = runner('git', args, { cwd });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    // spawnSync reports null when the process was killed by a signal; treat
    // that as a non-zero exit so every call site can branch on status === 0.
    status: result.status ?? -1,
  };
}

export function detectSourceCheckout(
  runtimeRoot: string,
  runner: SourceRunner = defaultRunner,
): SourceCheckoutDetection {
  if (!existsSync(join(runtimeRoot, '.git'))) {
    return { isSource: false, reason: 'no .git directory at runtimeRoot' };
  }
  const branchResult = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], runner, runtimeRoot);
  if (branchResult.status !== 0) {
    return { isSource: false, reason: `git rev-parse failed: ${branchResult.stderr.trim()}` };
  }
  const headResult = runGit(['rev-parse', 'HEAD'], runner, runtimeRoot);
  if (headResult.status !== 0) {
    return { isSource: false, reason: 'git HEAD read failed' };
  }
  const remoteResult = runGit(['config', '--get', 'remote.origin.url'], runner, runtimeRoot);
  return {
    isSource: true,
    head: headResult.stdout.trim(),
    branch: branchResult.stdout.trim(),
    remote: remoteResult.status === 0 ? remoteResult.stdout.trim() : undefined,
  };
}

function hashFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const bytes = readFileSync(path);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

function resolveBranchRef(
  runner: SourceRunner,
  runtimeRoot: string,
  branch: string,
): string {
  // `origin/<branch>` tracks the remote if `git fetch` ran. Fall back to
  // HEAD when the user is already on a disconnected branch.
  return `origin/${branch}`;
}

export function checkSourceUpdate(
  runtimeRoot: string,
  runner: SourceRunner = defaultRunner,
): SourceCheckResult {
  const detection = detectSourceCheckout(runtimeRoot, runner);
  if (!detection.isSource) {
    return {
      ok: false,
      mode: 'source-checkout',
      updateAvailable: false,
      currentCommit: '',
      latestCommit: '',
      commitsBehind: 0,
      subjects: [],
      remote: '',
      branch: '',
      error: detection.reason ?? 'not a source checkout',
    };
  }

  const branch = detection.branch!;
  const fetch = runGit(['fetch', '--quiet', 'origin'], runner, runtimeRoot);
  if (fetch.status !== 0) {
    return {
      ok: false,
      mode: 'source-checkout',
      updateAvailable: false,
      currentCommit: detection.head ?? '',
      latestCommit: '',
      commitsBehind: 0,
      subjects: [],
      remote: detection.remote ?? '',
      branch,
      error: `git fetch failed: ${fetch.stderr.trim() || fetch.stdout.trim()}`,
    };
  }

  const refName = resolveBranchRef(runner, runtimeRoot, branch);
  const latest = runGit(['rev-parse', refName], runner, runtimeRoot);
  if (latest.status !== 0) {
    return {
      ok: false,
      mode: 'source-checkout',
      updateAvailable: false,
      currentCommit: detection.head ?? '',
      latestCommit: '',
      commitsBehind: 0,
      subjects: [],
      remote: detection.remote ?? '',
      branch,
      error: `could not resolve ${refName}: ${latest.stderr.trim()}`,
    };
  }

  const latestCommit = latest.stdout.trim();
  const currentCommit = detection.head ?? '';

  if (currentCommit === latestCommit) {
    return {
      ok: true,
      mode: 'source-checkout',
      updateAvailable: false,
      currentCommit,
      latestCommit,
      commitsBehind: 0,
      subjects: [],
      remote: detection.remote ?? '',
      branch,
    };
  }

  const log = runGit(
    ['log', '--pretty=%s', `${currentCommit}..${latestCommit}`],
    runner,
    runtimeRoot,
  );
  const subjects =
    log.status === 0
      ? log.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : [];

  return {
    ok: true,
    mode: 'source-checkout',
    updateAvailable: true,
    currentCommit,
    latestCommit,
    commitsBehind: subjects.length,
    subjects,
    remote: detection.remote ?? '',
    branch,
  };
}

export function installSourceUpdate(
  runtimeRoot: string,
  opts: SourceInstallOptions = {},
): SourceInstallResult {
  const runner = opts.runner ?? defaultRunner;
  const rawEnv = opts.rawEnv ?? process.env;
  const started = Date.now();
  const warnings: string[] = [];

  const check = checkSourceUpdate(runtimeRoot, runner);
  const baseResult: SourceInstallResult = {
    ok: false,
    mode: 'source-checkout',
    dryRun: Boolean(opts.dryRun),
    fromCommit: check.currentCommit,
    toCommit: check.latestCommit,
    commitsPulled: check.commitsBehind,
    packageLockChanged: false,
    installed: false,
    built: false,
    serviceRestarted: false,
    durationMs: 0,
    warnings,
  };

  if (!check.ok) {
    return {
      ...baseResult,
      failedStage: 'fetch',
      error: check.error,
      durationMs: Date.now() - started,
    };
  }

  if (!check.updateAvailable) {
    return {
      ...baseResult,
      ok: true,
      toCommit: check.currentCommit,
      durationMs: Date.now() - started,
    };
  }

  // Dirty-tree guard.
  const status = runGit(['status', '--porcelain'], runner, runtimeRoot);
  if (status.status !== 0) {
    return {
      ...baseResult,
      failedStage: 'dirty-tree',
      error: 'git status failed',
      durationMs: Date.now() - started,
    };
  }
  const dirty = status.stdout.trim();
  if (dirty.length > 0) {
    return {
      ...baseResult,
      failedStage: 'dirty-tree',
      error: `working tree has uncommitted changes:\n${dirty}`,
      durationMs: Date.now() - started,
    };
  }

  if (opts.dryRun) {
    return { ...baseResult, ok: true, durationMs: Date.now() - started };
  }

  const lockPath = join(runtimeRoot, 'package-lock.json');
  const preHash = hashFile(lockPath);

  const pull = runGit(['pull', '--ff-only', 'origin', check.branch], runner, runtimeRoot);
  if (pull.status !== 0) {
    return {
      ...baseResult,
      failedStage: 'pull',
      error: `git pull --ff-only failed: ${pull.stderr.trim() || pull.stdout.trim()}`,
      durationMs: Date.now() - started,
    };
  }

  const postHash = hashFile(lockPath);
  const packageLockChanged = Boolean(preHash && postHash && preHash !== postHash);

  let installed = false;
  if (packageLockChanged) {
    const install = runner('npm', ['install'], { cwd: runtimeRoot });
    if (install.status !== 0) {
      return {
        ...baseResult,
        packageLockChanged,
        failedStage: 'install',
        error: `npm install failed: ${install.stderr.trim().slice(-1000)}`,
        durationMs: Date.now() - started,
      };
    }
    installed = true;
  }

  let built = false;
  if (!opts.skipBuild) {
    const build = runner('npm', ['run', 'build'], { cwd: runtimeRoot });
    if (build.status !== 0) {
      return {
        ...baseResult,
        packageLockChanged,
        installed,
        failedStage: 'build',
        error: `npm run build failed: ${build.stderr.trim().slice(-1000)}`,
        durationMs: Date.now() - started,
      };
    }
    built = true;
  } else {
    warnings.push('build skipped (--skip-build)');
  }

  let serviceRestarted = false;
  if (!opts.skipRestart) {
    try {
      const currentStatus = getUserServiceStatus(runtimeRoot, rawEnv, runner);
      if (currentStatus.active) {
        restartUserService(runtimeRoot, rawEnv, runner);
        serviceRestarted = true;
      } else {
        warnings.push('service not active; skipped restart');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        packageLockChanged,
        installed,
        built,
        failedStage: 'restart',
        error: `service restart failed: ${message}`,
        durationMs: Date.now() - started,
      };
    }
  } else {
    warnings.push('service restart skipped (--skip-restart)');
  }

  return {
    ok: true,
    mode: 'source-checkout',
    dryRun: false,
    fromCommit: check.currentCommit,
    toCommit: check.latestCommit,
    commitsPulled: check.commitsBehind,
    packageLockChanged,
    installed,
    built,
    serviceRestarted,
    durationMs: Date.now() - started,
    warnings,
  };
}
