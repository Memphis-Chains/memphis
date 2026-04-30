import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * macOS-portable tmpdir.
 *
 * On macOS `os.tmpdir()` returns `/var/folders/<…>/T/` but Memphis path
 * resolvers — notably `resolveInstallRoot` in
 * `src/infra/runtime/install-root.ts` — call `realpathSync()` to follow
 * the `/var/folders/…` → `/private/var/folders/…` symlink that macOS
 * inserts. Any test that builds a fixture path with `os.tmpdir()` and
 * then compares it against a path produced through Memphis' resolution
 * chain would otherwise fail on macOS with `expected '/private/var/…'
 * to be '/var/…'`. The 2026-04-29 cross-arch CI run on PR #371 surfaced
 * exactly this on 8 tests across cli.apps, install-root, managed-apps,
 * self-modify-path-validation, and vault-paths.
 *
 * Calling `realpathSync(tmpdir())` once at module load means both sides
 * of the comparison are dereferenced consistently. On Linux this is a
 * no-op (no symlink to follow) so existing assertions stay green.
 */
export function realTmpdir(): string {
  return realpathSync(tmpdir());
}
