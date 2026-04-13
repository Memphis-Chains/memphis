/**
 * Minimal SemVer comparison for the `memphis self-update` CLI.
 *
 * Intentionally limited in scope: we only need `MAJOR.MINOR.PATCH`
 * comparison against GitHub release tags (which may be `v1.2.3` or
 * `1.2.3`). No pre-release / build-metadata support — the Memphis
 * release pipeline doesn't use those today and adding them here would
 * create a maintenance surface for capability we can't exercise.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.]+)?$/;

export function parseSemVer(raw: string): SemVer | null {
  if (!raw) return null;
  const match = SEMVER_RE.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number.parseInt(match[1]!, 10),
    minor: Number.parseInt(match[2]!, 10),
    patch: Number.parseInt(match[3]!, 10),
  };
}

/** -1 when a < b, 0 when equal, 1 when a > b. null if either input is invalid. */
export function compareSemVer(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareSemVer(current, latest) === -1;
}
