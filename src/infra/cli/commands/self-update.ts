import { getAppVersion } from '../../../config/paths.js';
import { resolveRuntimeRoot } from '../../runtime/user-service.js';
import { checkForUpdate } from '../../self-update/github-release.js';
import { installUpdate, rollbackUpdate } from '../../self-update/installer.js';
import {
  checkSourceUpdate,
  detectSourceCheckout,
  installSourceUpdate,
} from '../../self-update/source-checkout.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function shouldForceReleaseMode(env: NodeJS.ProcessEnv): boolean {
  const value = env.MEMPHIS_SELF_UPDATE_FORCE_RELEASE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * `memphis self-update` — operator-facing release awareness.
 *
 * - `check`    — queries GitHub for the latest release (Sprint 14).
 * - `install`  — downloads the tarball, verifies the detached GPG
 *                signature, extracts under `~/.memphis/versions/<tag>/`,
 *                atomically swaps the `~/.memphis/current` symlink, and
 *                records the transition in `install-state.json`.
 *                Does NOT restart — operators sequence that manually.
 * - `rollback` — flips the symlink back to the previous version
 *                captured in `install-state.json`.
 *
 * Signature verification requires `MEMPHIS_SELF_UPDATE_PUBKEY_PATH` to
 * point at a pinned operator GPG public key. Dev-only bypass:
 * `MEMPHIS_SELF_UPDATE_SKIP_SIG=true` (logged, not intended for prod).
 */
export async function handleSelfUpdateCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  if (args.command !== 'self-update') return false;

  const subcommand = args.subcommand?.toLowerCase() ?? 'check';

  // Source-checkout mode: if we're running out of a git clone (the common
  // install path today since the last release tag) and the operator hasn't
  // forced release mode, route to git-aware check/install.
  const runtimeRoot = (() => {
    try {
      return resolveRuntimeRoot(process.cwd());
    } catch {
      return null;
    }
  })();
  const sourceDetection = runtimeRoot ? detectSourceCheckout(runtimeRoot) : null;
  const useSourceMode =
    !shouldForceReleaseMode(process.env) &&
    sourceDetection?.isSource === true &&
    runtimeRoot !== null;

  if (useSourceMode && (subcommand === 'check' || subcommand === 'install')) {
    const currentVersion = getAppVersion();
    if (subcommand === 'check') {
      const result = checkSourceUpdate(runtimeRoot!);
      const summary = !result.ok
        ? `self-update check failed: ${result.error}`
        : result.updateAvailable
          ? `${result.commitsBehind} commit(s) behind ${result.remote}/${result.branch}: ${result.currentCommit.slice(0, 7)} → ${result.latestCommit.slice(0, 7)}`
          : `up to date (source-checkout on ${result.branch})`;
      print(
        {
          ...result,
          mode: 'check',
          source: 'source-checkout',
          currentVersion,
          summary,
        },
        args.json,
      );
      return true;
    }

    // subcommand === 'install'
    const outcome = installSourceUpdate(runtimeRoot!, {
      dryRun: args.dryRun === true,
      skipRestart: args.skipRestart === true,
      skipBuild: args.skipBuild === true,
    });
    const summary = !outcome.ok
      ? `install failed at stage '${outcome.failedStage ?? 'unknown'}': ${outcome.error}`
      : outcome.dryRun
        ? `dry run: ${outcome.commitsPulled} commit(s) pending ${outcome.fromCommit.slice(0, 7)} → ${outcome.toCommit.slice(0, 7)}; nothing changed`
        : outcome.commitsPulled === 0
          ? 'already up to date (source-checkout)'
          : [
              `pulled ${outcome.commitsPulled} commit(s)`,
              outcome.packageLockChanged ? 'npm install ran' : 'npm install skipped (lockfile unchanged)',
              outcome.built ? 'build succeeded' : 'build skipped',
              outcome.serviceRestarted ? 'service restarted' : 'service not restarted',
            ].join('; ');
    print({ ...outcome, mode: 'install', source: 'source-checkout', summary }, args.json);
    return true;
  }

  if (useSourceMode && subcommand === 'rollback') {
    print(
      {
        ok: false,
        mode: 'rollback',
        source: 'source-checkout',
        summary:
          'rollback is not supported in source-checkout mode. Use git directly: git reset --hard <previous-commit> && npm run build && memphis service restart.',
      },
      args.json,
    );
    return true;
  }

  if (subcommand === 'check') {
    const currentVersion = getAppVersion();
    const result = await checkForUpdate(currentVersion);

    const summary = result.error
      ? `self-update check failed: ${result.error}`
      : result.updateAvailable
        ? `update available: ${currentVersion} → ${result.latestVersion}`
        : `up to date (${currentVersion})`;

    print(
      {
        ok: !result.error,
        mode: 'check',
        source: 'release',
        ...result,
        summary,
      },
      args.json,
    );
    return true;
  }

  if (subcommand === 'install') {
    const currentVersion = getAppVersion();
    const outcome = await installUpdate({ currentVersion });
    const summary = outcome.ok
      ? outcome.skipped === 'up-to-date'
        ? `already up to date (${currentVersion})`
        : `installed ${outcome.toVersion} at ${outcome.installPath}. Restart Memphis to activate the new version.`
      : `install failed at stage '${outcome.failedStage ?? 'unknown'}': ${outcome.error}`;
    print({ mode: 'install', source: 'release', ...outcome, summary }, args.json);
    return true;
  }

  if (subcommand === 'rollback') {
    const outcome = await rollbackUpdate();
    const summary = outcome.ok
      ? `rolled back from ${outcome.fromVersion} to ${outcome.toVersion}. Restart Memphis to activate.`
      : `rollback failed: ${outcome.error}`;
    print({ mode: 'rollback', source: 'release', ...outcome, summary }, args.json);
    return true;
  }

  throw new Error(`Unknown self-update subcommand: ${subcommand}. Try: check | install | rollback`);
}
