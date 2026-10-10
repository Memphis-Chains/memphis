/**
 * The automerge decision, executed.
 *
 * automerge-decision-contract.test.ts asserts the workflow says the right
 * things. This one runs the script it contains, against a fake `gh`, and
 * asserts what it actually does.
 *
 * The stub answers only what the workflow asks: `gh api --jq <expr>` is read
 * for the check name, and the verdict for that name is looked up in a file.
 * Anything unrecognised is "missing" — a check that did not report is not a
 * check that passed.
 *
 * Two harness mistakes are recorded here because both looked like workflow
 * bugs and were not:
 *
 *   - the stub shelled out to a stub jq, then read the check name out of `$*`
 *     with a greedy sed, and matched the verdict file instead of the name.
 *   - `required` was defaulted to the verdicts file joined by commas, so the
 *     workflow was asked about a check literally named "chain-invariant=success".
 *
 * In both cases the workflow was told "missing" and correctly refused to merge.
 * A stub that lies in the safe direction hides the real bug, the same shape as
 * the branch-protection fake that answered 200 to everything.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const wfPath = path.join(repoRoot, '.github/workflows/automerge.yml');

const tempDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

/** The two run blocks, pulled out of the workflow as plain bash. */
function steps(): { policy: string; merge: string } {
  const wf = parseYaml(readFileSync(wfPath, 'utf8')) as {
    jobs: { automerge: { steps: Array<{ run?: string }> } };
  };
  const runs = wf.jobs.automerge.steps.map((s) => s.run ?? '').filter(Boolean);
  expect(runs.length).toBeGreaterThanOrEqual(2);
  return { policy: runs[0] as string, merge: runs[1] as string };
}

const CHECK_NAMES = [
  'chain-invariant',
  'cross-arch (macos-latest)',
  'cross-arch (ubuntu-24.04-arm)',
  'quality-gate',
];

/** `name=conclusion` lines, which is the verdicts file format the stub reads. */
function verdictsFor(overrides: Record<string, string> = {}): string {
  return CHECK_NAMES.map((name) => `${name}=${overrides[name] ?? 'success'}`).join('\n') + '\n';
}

/**
 * Install a fake `gh` on PATH.
 *
 * It reads the `--jq` argument itself: `gh api --jq` evaluates with gh's own
 * evaluator, not with the system jq, so there is nothing to delegate to. The
 * expression the workflow uses has the check name in quotes after `.name ==`.
 */
function installStub(dir: string, verdictsFile: string): void {
  const gh = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    'if [[ "${1:-}" == "api" ]]; then',
    '  expr=""',
    '  while [[ $# -gt 0 ]]; do',
    '    if [[ "$1" == "--jq" ]]; then expr="${2:-}"; shift 2; else shift; fi',
    '  done',
    '  name="$(printf %s "$expr" | sed -n \'s/.*\\.name == "\\([^"]*\\)".*/\\1/p\')"',
    '  v="missing"',
    `  if [[ -n "$name" && -f "${verdictsFile}" ]]; then`,
    `    v="$(grep -F -- "$name=" "${verdictsFile}" | head -1 | cut -d= -f2- || true)"`,
    '    [[ -z "$v" ]] && v="missing"',
    '  fi',
    '  printf "%s\\n" "$v"',
    '  exit 0',
    'fi',
    'echo "MERGE-CALLED: $*"',
    '',
  ].join('\n');
  const p = path.join(dir, 'gh');
  writeFileSync(p, gh, 'utf8');
  chmodSync(p, 0o755);
}

function runMerge(verdicts: string, required = CHECK_NAMES.join(',')) {
  const binDir = tmp('memphis-stub-');
  const verdictsFile = path.join(binDir, 'verdicts');
  writeFileSync(verdictsFile, verdicts, 'utf8');
  installStub(binDir, verdictsFile);

  return spawnSync('bash', ['-c', steps().merge], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'Memphis-Chains/memphis',
      PR_NUMBER: '999',
      HEAD_SHA: 'deadbeef',
      REQUIRED: required,
    },
    encoding: 'utf8',
  });
}

/** Run the policy step with a stub curl that returns `rulesetJson`. */
/**
 * The payload `/rules/branches/<branch>` actually returns, as measured on this
 * repository 2026-10-10. Every entry is a rule with its own `type`; the status
 * check rule carries its contexts under `parameters`. The ruleset LIST endpoint
 * returns metadata with no `rules` key at all, which is why this shape exists.
 */
function branchRules(contexts: string[] = CHECK_NAMES, extra: unknown[] = []): string {
  return JSON.stringify([
    { type: 'deletion', ruleset_id: 1, ruleset_source_type: 'Repository' },
    { type: 'non_fast_forward', ruleset_id: 1, ruleset_source_type: 'Repository' },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: contexts.map((context) => ({ context })),
      },
      ruleset_source_type: 'Repository',
      ruleset_id: 1,
    },
    ...extra,
  ]);
}

function runPolicy(rulesetJson: string) {
  const binDir = tmp('memphis-curl-');
  const curlPath = path.join(binDir, 'curl');
  // Record the URL. A stub that answers every endpoint with the same body cannot
  // tell /rulesets from /rules/branches/<branch>, so a regression in the URL the
  // workflow reads passes silently — which is exactly how the original bug hid.
  const urlFile = path.join(tmp('memphis-url-'), 'requested');
  writeFileSync(
    curlPath,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${urlFile}"\ncat <<'JSON'\n${rulesetJson}\nJSON\n`,
    'utf8',
  );
  chmodSync(curlPath, 0o755);

  const outFile = path.join(tmp('memphis-out-'), 'gh_output');
  const r = spawnSync('bash', ['-c', steps().policy], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'Memphis-Chains/memphis',
      GITHUB_OUTPUT: outFile,
    },
    encoding: 'utf8',
  });
  return { r, outFile, urlFile };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe('automerge — merges only when every required check passed', () => {
  it('merges when all four are green', () => {
    const r = runMerge(verdictsFor());
    expect(r.stdout).toContain('merging');
    expect(r.stdout).toContain('MERGE-CALLED');
    expect(r.stdout).toContain('--squash');
  });

  it.each(['quality-gate', 'cross-arch (macos-latest)', 'chain-invariant'])(
    'does not merge when %s fails',
    (ctx) => {
      const r = runMerge(verdictsFor({ [ctx]: 'failure' }));
      expect(r.stdout).toContain('Not merging');
      expect(r.stdout).not.toContain('MERGE-CALLED');
    },
  );

  it('does not merge while a check is still pending', () => {
    // An empty verdict is what a run with no conclusion yet produces.
    const r = runMerge(verdictsFor({ 'quality-gate': '' }));
    expect(r.stdout).toContain('Not merging');
    expect(r.stdout).not.toContain('MERGE-CALLED');
  });

  it('does not merge when a required check has no run at all', () => {
    // The ruleset requires a check that produced no run on this commit, so the
    // stub reports "missing" for it. A check that never ran is not a check that
    // passed — this is the case that lets a red branch through if "missing"
    // were treated as success.
    const verdicts =
      verdictsFor()
        .split('\n')
        .filter((l) => !l.startsWith('cross-arch (macos-latest)='))
        .join('\n') + '\n';
    const r = runMerge(verdicts);
    expect(r.stdout).toContain('Not merging');
    expect(r.stdout).not.toContain('MERGE-CALLED');
  });

  it('handles required names containing spaces and parentheses', () => {
    // "cross-arch (macos-latest)" is the most likely way to break comma
    // splitting or quoting, and it is one of the four real names.
    const r = runMerge(verdictsFor());
    expect(r.stdout).toContain('MERGE-CALLED');
  });
});

describe('automerge — an unreadable policy blocks the merge', () => {
  it('refuses when the branch has no required status checks', () => {
    const { r } = runPolicy(JSON.stringify([{ type: 'deletion', ruleset_id: 1 }]));
    expect(r.status).not.toBe(0);
    // GitHub workflow commands are stdout annotations, not shell redirects:
    // `::error::` on stderr would never be rendered on the run page.
    expect(`${r.stdout}${r.stderr}`).toContain('refusing to auto-merge');
  });

  it('refuses when the ruleset metadata has no rules array', () => {
    // The exact payload the old reader was fed: ruleset list entries carry no
    // `rules` key. This is the regression that made automerge skip every run.
    const { r, urlFile } = runPolicy(
      JSON.stringify([{ id: 1, name: 'main', enforcement: 'active', target: 'branch' }]),
    );
    expect(r.status).not.toBe(0);
    // Same shape, and it must still be fetched from the branch endpoint.
    expect(readFileSync(urlFile, 'utf8')).toContain('/rules/branches/main');
    expect(`${r.stdout}${r.stderr}`).toContain('refusing to auto-merge');
  });

  it('passes the four real checks through from the ruleset', () => {
    const { r, outFile, urlFile } = runPolicy(branchRules());
    expect(r.status).toBe(0);
    // The endpoint itself is the contract: the ruleset LIST carries no rules.
    expect(readFileSync(urlFile, 'utf8')).toContain('/rules/branches/main');
    const written = readFileSync(outFile, 'utf8');
    for (const name of CHECK_NAMES) {
      expect(written).toContain(name);
    }
  });
});
