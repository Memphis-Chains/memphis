/**
 * Self-update install + rollback (closes deferred item #1).
 *
 * The check path has shipped since Sprint 14. This module adds the
 * install and rollback mechanics on top.
 *
 * Layout:
 *   ~/.memphis/versions/
 *     v1.2.1/
 *     v1.3.0/
 *     ...
 *   ~/.memphis/current -> symlink into versions/v1.3.0
 *   ~/.memphis/install-state.json -> { current, previous, history[] }
 *
 * Install:
 *   1. Resolve the latest release via the existing `checkForUpdate`
 *      machinery (reuses cache + in-flight dedup).
 *   2. Download the tarball to a temp path.
 *   3. Verify the detached `.sig` signature against a pinned operator
 *      GPG public key (MEMPHIS_SELF_UPDATE_PUBKEY_PATH). Signature
 *      verification is BYPASSED only when
 *      MEMPHIS_SELF_UPDATE_SKIP_SIG=true — explicit dev-only opt-out.
 *   4. Extract to ~/.memphis/versions/<tag>/
 *   5. Atomically re-point the `current` symlink.
 *   6. Record the transition in install-state.json.
 *
 * Rollback:
 *   1. Read install-state.json; if `previous` is null, refuse.
 *   2. Confirm the previous version directory exists.
 *   3. Re-point `current` symlink atomically.
 *   4. Swap `current` / `previous` in state.
 *
 * The installer does NOT call `requestRestart` — operators restart
 * manually so they can sequence the swap with traffic draining.
 *
 * This is a skeleton with seams for the real tarball download +
 * extraction. The seam points (`fetchFn`, `verifyFn`, `extractFn`) mean
 * the flow is exercised by tests without needing a signed release.
 */

import { createWriteStream, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { checkForUpdate, type SelfUpdateCheckResult } from './github-release.js';

export type InstallStage =
  | 'resolve-release'
  | 'download'
  | 'verify-signature'
  | 'extract'
  | 'activate-symlink'
  | 'update-state';

export interface InstallOutcome {
  ok: boolean;
  fromVersion: string;
  toVersion: string | null;
  installPath: string | null;
  skipped?: 'up-to-date' | 'no-release';
  error?: string;
  failedStage?: InstallStage;
}

export interface RollbackOutcome {
  ok: boolean;
  fromVersion: string | null;
  toVersion: string | null;
  error?: string;
}

export interface InstallStateFile {
  current: {
    version: string;
    path: string;
    installedAt: string;
  } | null;
  previous: {
    version: string;
    path: string;
    installedAt: string;
  } | null;
  history: Array<{
    version: string;
    installedAt: string;
  }>;
}

export interface InstallOptions {
  currentVersion: string;
  installRoot?: string;
  rawEnv?: NodeJS.ProcessEnv;
  /** Test seam: download a URL to a local file path. Default uses fetch(). */
  fetchFn?: (url: string, destPath: string) => Promise<void>;
  /** Test seam: verify sigPath signs tarballPath. Default uses GPG or bypasses when MEMPHIS_SELF_UPDATE_SKIP_SIG=true. */
  verifyFn?: (tarballPath: string, sigPath: string, rawEnv: NodeJS.ProcessEnv) => Promise<void>;
  /** Test seam: extract tarball → destDir. Default uses `tar -xzf`. */
  extractFn?: (tarballPath: string, destDir: string) => Promise<void>;
  /** Test seam for the check path. Default uses `checkForUpdate`. */
  checkFn?: (currentVersion: string) => Promise<SelfUpdateCheckResult>;
}

export interface RollbackOptions {
  installRoot?: string;
  rawEnv?: NodeJS.ProcessEnv;
}

function resolveInstallRoot(options: { installRoot?: string; rawEnv?: NodeJS.ProcessEnv }): string {
  if (options.installRoot) return options.installRoot;
  const env = options.rawEnv ?? process.env;
  if (env.MEMPHIS_SELF_UPDATE_ROOT) return env.MEMPHIS_SELF_UPDATE_ROOT;
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  return path.join(home, '.memphis');
}

function versionsDir(root: string): string {
  return path.join(root, 'versions');
}

function currentSymlink(root: string): string {
  return path.join(root, 'current');
}

function stateFilePath(root: string): string {
  return path.join(root, 'install-state.json');
}

async function readInstallState(root: string): Promise<InstallStateFile> {
  try {
    const raw = await fs.readFile(stateFilePath(root), 'utf8');
    const parsed = JSON.parse(raw) as InstallStateFile;
    return {
      current: parsed.current ?? null,
      previous: parsed.previous ?? null,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return { current: null, previous: null, history: [] };
  }
}

async function writeInstallState(root: string, state: InstallStateFile): Promise<void> {
  const tmp = `${stateFilePath(root)}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, stateFilePath(root));
}

async function atomicSwapSymlink(linkPath: string, targetPath: string): Promise<void> {
  const tmpLink = `${linkPath}.tmp-${process.pid}`;
  try {
    await fs.rm(tmpLink, { force: true });
  } catch {
    // best-effort
  }
  await fs.symlink(targetPath, tmpLink);
  await fs.rename(tmpLink, linkPath);
}

async function defaultFetch(url: string, destPath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${url}`);
  if (!res.body) throw new Error(`download failed: no body from ${url}`);
  const nodeStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
  const out = createWriteStream(destPath);
  await pipeline(nodeStream, out);
}

async function defaultVerify(
  tarballPath: string,
  sigPath: string,
  rawEnv: NodeJS.ProcessEnv,
): Promise<void> {
  const skip = rawEnv.MEMPHIS_SELF_UPDATE_SKIP_SIG?.trim().toLowerCase();
  if (skip === 'true' || skip === '1') return;

  const pubkeyPath = rawEnv.MEMPHIS_SELF_UPDATE_PUBKEY_PATH;
  if (!pubkeyPath) {
    throw new Error(
      'signature verification required but MEMPHIS_SELF_UPDATE_PUBKEY_PATH is not set. Set the env to a pinned operator GPG public key path, or explicitly opt out with MEMPHIS_SELF_UPDATE_SKIP_SIG=true (dev only).',
    );
  }
  if (!existsSync(pubkeyPath)) {
    throw new Error(`signature verification failed: pubkey not found at ${pubkeyPath}`);
  }
  if (!existsSync(sigPath)) {
    throw new Error(`signature verification failed: detached .sig not found at ${sigPath}`);
  }

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  // Import the pubkey into an ephemeral gpg keyring, then verify.
  const keyringDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memphis-sigverify-'));
  try {
    await execFileAsync('gpg', [
      '--homedir',
      keyringDir,
      '--quiet',
      '--batch',
      '--import',
      pubkeyPath,
    ]);
    await execFileAsync('gpg', [
      '--homedir',
      keyringDir,
      '--quiet',
      '--batch',
      '--verify',
      sigPath,
      tarballPath,
    ]);
  } finally {
    await fs.rm(keyringDir, { recursive: true, force: true });
  }
}

async function defaultExtract(tarballPath: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', destDir, '--strip-components=1']);
}

export async function installUpdate(options: InstallOptions): Promise<InstallOutcome> {
  const rawEnv = options.rawEnv ?? process.env;
  const installRoot = resolveInstallRoot({ installRoot: options.installRoot, rawEnv });
  const checkFn = options.checkFn ?? ((v: string) => checkForUpdate(v));
  const fetchFn = options.fetchFn ?? defaultFetch;
  const verifyFn = options.verifyFn ?? defaultVerify;
  const extractFn = options.extractFn ?? defaultExtract;

  let stage: InstallStage = 'resolve-release';
  try {
    const check = await checkFn(options.currentVersion);
    if (check.error || !check.release) {
      return {
        ok: false,
        fromVersion: options.currentVersion,
        toVersion: null,
        installPath: null,
        skipped: 'no-release',
        error: check.error ?? 'no release metadata returned',
        failedStage: stage,
      };
    }
    if (!check.updateAvailable) {
      return {
        ok: true,
        fromVersion: options.currentVersion,
        toVersion: check.latestVersion,
        installPath: null,
        skipped: 'up-to-date',
      };
    }
    const targetVersion = check.latestVersion ?? check.release.tag.replace(/^v/, '');
    const tarballUrl = check.release.tarballUrl;
    if (!tarballUrl) {
      return {
        ok: false,
        fromVersion: options.currentVersion,
        toVersion: targetVersion,
        installPath: null,
        error: 'release has no tarballUrl',
        failedStage: stage,
      };
    }

    // Stage directories
    await fs.mkdir(versionsDir(installRoot), { recursive: true });
    const versionDir = path.join(versionsDir(installRoot), `v${targetVersion}`);
    const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memphis-selfupdate-'));
    const tarballPath = path.join(downloadDir, 'release.tar.gz');
    const sigPath = `${tarballPath}.sig`;
    const sigUrl = `${tarballUrl}.sig`;

    try {
      stage = 'download';
      await fetchFn(tarballUrl, tarballPath);
      // Detached sig — best-effort. If verify is not skipped, it MUST
      // exist; the default verifier throws if the file is missing.
      try {
        await fetchFn(sigUrl, sigPath);
      } catch {
        // Non-fatal here; verifier will refuse if it needs the sig.
      }

      stage = 'verify-signature';
      await verifyFn(tarballPath, sigPath, rawEnv);

      stage = 'extract';
      await extractFn(tarballPath, versionDir);

      stage = 'activate-symlink';
      await atomicSwapSymlink(currentSymlink(installRoot), versionDir);

      stage = 'update-state';
      const state = await readInstallState(installRoot);
      const installedAt = new Date().toISOString();
      const newState: InstallStateFile = {
        current: { version: `v${targetVersion}`, path: versionDir, installedAt },
        previous: state.current,
        history: [...state.history, { version: `v${targetVersion}`, installedAt }].slice(-50),
      };
      await writeInstallState(installRoot, newState);

      return {
        ok: true,
        fromVersion: options.currentVersion,
        toVersion: targetVersion,
        installPath: versionDir,
      };
    } finally {
      await fs.rm(downloadDir, { recursive: true, force: true });
    }
  } catch (err) {
    return {
      ok: false,
      fromVersion: options.currentVersion,
      toVersion: null,
      installPath: null,
      error: err instanceof Error ? err.message : String(err),
      failedStage: stage,
    };
  }
}

export async function rollbackUpdate(
  options: RollbackOptions = {},
): Promise<RollbackOutcome> {
  const rawEnv = options.rawEnv ?? process.env;
  const installRoot = resolveInstallRoot({ installRoot: options.installRoot, rawEnv });
  const state = await readInstallState(installRoot);

  if (!state.previous) {
    return {
      ok: false,
      fromVersion: state.current?.version ?? null,
      toVersion: null,
      error: 'no previous version recorded — cannot roll back',
    };
  }
  if (!existsSync(state.previous.path)) {
    return {
      ok: false,
      fromVersion: state.current?.version ?? null,
      toVersion: state.previous.version,
      error: `previous version directory is missing: ${state.previous.path}`,
    };
  }

  await atomicSwapSymlink(currentSymlink(installRoot), state.previous.path);
  const newState: InstallStateFile = {
    current: state.previous,
    previous: state.current,
    history: state.history,
  };
  await writeInstallState(installRoot, newState);

  return {
    ok: true,
    fromVersion: state.current?.version ?? null,
    toVersion: state.previous.version,
  };
}
