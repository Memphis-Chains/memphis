/**
 * The forbidden-path gate — what may never enter the repository.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED 2026-11-26 on the operator's host: a `.env` file was committed
 * in 16 commits in March 2026 and stayed in the published history for
 * eight months, carrying two vault peppers and one API token (all since
 * rotated). The history had to be rewritten with `git filter-repo` and a
 * force-push of every branch and tag — a sledgehammer that needs the
 * operator's consent and a window in which branch protection is relaxed.
 *
 * This gate is the cheap half of the answer: a path that never enters the
 * repository needs no rewrite.
 *
 * The rule has one owner — `src/infra/audit/forbidden-paths.ts` — and two
 * runners: this gate, over the files that are staged right now, and the
 * corpus (`tests/fixtures/forbidden-path-cases.json`), which pins the rule
 * itself.
 *
 * WHAT IS FLAGGED
 * ---------------
 *   - `.env` and `.env.*` (`.env.example` excepted: a template holds no
 *     values, and the repository carries it on purpose)
 *   - `vault-state.json`
 *   - `*.tier2-passphrase`
 *   - `.github-pat`
 *   - anything under `dist/` or `node_modules/`
 *
 * The gate reads PATHS only. It never opens a staged file, so it can never
 * print a secret into a log.
 *
 * Run: `npm run -s ops:check-forbidden-paths`
 * Hook: .githooks/pre-commit runs it on every staged change.
 */

import { execFileSync } from 'node:child_process';

import {
  findForbiddenPathFindings,
  type ForbiddenPathFinding,
} from '../src/infra/audit/forbidden-paths.js';

function stagedPaths(): string[] {
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    console.error(`forbidden-path gate: cannot read the staged files (${String(error)})`);
    process.exit(1);
  }
}

const paths = stagedPaths();
const findings: ForbiddenPathFinding[] = findForbiddenPathFindings(paths);

if (findings.length > 0) {
  console.error('forbidden-path gate FAILED\n');
  for (const finding of findings) {
    console.error(`  ${finding.path} [${finding.rule}]: ${finding.problem}`);
  }
  console.error('\nUnstage the path, or commit the template (.env.example) instead of the file.');
  process.exit(1);
}

console.log(`forbidden-path gate OK — ${paths.length} staged path(s), none forbidden`);
