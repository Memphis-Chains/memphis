import { getAppVersion } from '../../../config/paths.js';
import { checkForUpdate } from '../../self-update/github-release.js';
import { installUpdate, rollbackUpdate } from '../../self-update/installer.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

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
    print({ mode: 'install', ...outcome, summary }, args.json);
    return true;
  }

  if (subcommand === 'rollback') {
    const outcome = await rollbackUpdate();
    const summary = outcome.ok
      ? `rolled back from ${outcome.fromVersion} to ${outcome.toVersion}. Restart Memphis to activate.`
      : `rollback failed: ${outcome.error}`;
    print({ mode: 'rollback', ...outcome, summary }, args.json);
    return true;
  }

  throw new Error(
    `Unknown self-update subcommand: ${subcommand}. Try: check | install | rollback`,
  );
}
