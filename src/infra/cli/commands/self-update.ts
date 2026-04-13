import { getAppVersion } from '../../../config/paths.js';
import { checkForUpdate } from '../../self-update/github-release.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

/**
 * `memphis self-update` — operator-facing release awareness.
 *
 * Sprint 14 ships the **check** path: query GitHub for the latest
 * release, compare to the local version, surface a structured result.
 * Actual `--install` and `--rollback` mechanics (tarball extraction,
 * symlink swap under `~/.memphis/versions/`) are deliberately a
 * follow-up so they can be drilled end-to-end against real release
 * artifacts with the GPG signing story (14b) wired first.
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

  if (subcommand === 'install' || subcommand === 'rollback') {
    print(
      {
        ok: false,
        mode: subcommand,
        error: `self-update ${subcommand} is not yet implemented. Use \`memphis self-update check\` to see the latest release, then install manually via the GitHub release page.`,
      },
      args.json,
    );
    return true;
  }

  throw new Error(
    `Unknown self-update subcommand: ${subcommand}. Try: check | install | rollback`,
  );
}
