/**
 * The forbidden-path rule — what may never enter the repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED 2026-11-26 on the operator's host, while rewriting the history:
 * a `.env` file was committed in 16 commits between 2026-03-10 and
 * 2026-03-15 and stayed in the published history for eight months. It
 * carried four non-empty values under keys that end in `_PEPPER` and
 * `_TOKEN` — two vault peppers and one API token, all of them since
 * rotated, but published the whole time.
 *
 * The rewrite took `git filter-repo` and a force-push of every branch and
 * tag. That is a sledgehammer: it rewrites every SHA in the repository,
 * and it can only be done with the operator's deliberate consent and a
 * window in which the branch protection is relaxed. A rule that prevents
 * the file from being committed in the first place costs nothing and does
 * not need a window.
 *
 * So the rule gets the same treatment the other repository rules got: ONE
 * owner (this module), ONE corpus of cases
 * (`tests/fixtures/forbidden-path-cases.json`), and TWO runners — the
 * pre-commit gate (`scripts/check-forbidden-paths.mts`) over the files
 * that are staged right now, and the unit test that pins the rule itself.
 *
 * WHAT IS FORBIDDEN
 * -----------------
 *   - `.env` and `.env.*` — the runtime's own configuration file. The
 *     exception is `.env.example`: a template with no values, which the
 *     repository DOES carry, because a template is how the operator learns
 *     which keys exist.
 *   - `vault-state.json` — the vault's own state.
 *   - `*.tier2-passphrase` — a tier-2 passphrase, by any name.
 *   - `.github-pat` — the GitHub personal access token.
 *   - anything under `dist/` or `node_modules/` — build output and
 *     dependencies. `.gitignore` already lists them; a second, explicit
 *     gate is what makes the rule checkable rather than merely intended.
 *
 * The rule is about PATHS, never about contents: the gate never reads a
 * staged file, so it can never print a secret to a log.
 */

/** A finding about one path. */
export interface ForbiddenPathFinding {
  /** The rule that fired. */
  rule: 'secret-env' | 'vault-state' | 'tier2-passphrase' | 'github-pat' | 'build-output';
  /** The path, as the operator would name it. */
  path: string;
  /** What is wrong, in the operator's words. */
  problem: string;
}

/** The template file that is allowed, because it holds no values. */
export const ALLOWED_ENV_TEMPLATE = '.env.example';

/**
 * Is this path under a build-output directory?
 *
 * The directory is what matters: `dist/` anywhere in the tree is build
 * output, and so is `node_modules/`. A file merely NAMED `dist` (a
 * document called `docs/dist.md`) is not under the directory.
 */
export function isUnderBuildOutput(path: string): boolean {
  const segments = path.trim().replace(/^\.\//, '').split('/').filter(Boolean);
  return segments.some((segment) => segment === 'dist' || segment === 'node_modules');
}

/**
 * Is this path a secret environment file?
 *
 * `.env` is the file itself; `.env.local`, `.env.production` and friends
 * are the same file with a different name. `.env.example` is a template
 * with no values and is the ONE name in this family that is allowed.
 */
export function isSecretEnvFile(path: string): boolean {
  const segments = path.trim().replace(/^\.\//, '').split('/').filter(Boolean);
  const name = segments[segments.length - 1];
  if (!name) return false;
  if (name === ALLOWED_ENV_TEMPLATE) return false;
  if (name === '.env') return true;
  return name.startsWith('.env.');
}

/** The rules, applied to one path. */
export function findForbiddenPathFindings(paths: readonly string[]): ForbiddenPathFinding[] {
  const findings: ForbiddenPathFinding[] = [];

  for (const raw of paths) {
    const path = raw.trim().replace(/^\.\//, '');
    if (!path) continue;
    const segments = path.split('/').filter(Boolean);
    const name = segments[segments.length - 1] ?? path;

    if (isSecretEnvFile(path)) {
      findings.push({
        rule: 'secret-env',
        path,
        problem:
          'the runtime configuration file does not belong in the repository — its values ' +
          'are secrets (a vault pepper, API tokens), and eight months of published history ' +
          'had to be rewritten on 2026-11-26 because this file was committed',
      });
      continue;
    }

    if (name === 'vault-state.json') {
      findings.push({
        rule: 'vault-state',
        path,
        problem: "the vault's own state file never enters the repository",
      });
      continue;
    }

    if (name.endsWith('.tier2-passphrase')) {
      findings.push({
        rule: 'tier2-passphrase',
        path,
        problem: 'a tier-2 passphrase never enters the repository, under any name',
      });
      continue;
    }

    if (name === '.github-pat') {
      findings.push({
        rule: 'github-pat',
        path,
        problem: 'the GitHub personal access token never enters the repository',
      });
      continue;
    }

    if (isUnderBuildOutput(path)) {
      findings.push({
        rule: 'build-output',
        path,
        problem: 'build output and dependencies are not repository content',
      });
    }
  }

  return findings;
}
