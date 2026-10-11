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
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
function steps(): { resolve: string; policy: string; merge: string } {
  const wf = parseYaml(readFileSync(wfPath, 'utf8')) as {
    jobs: { automerge: { steps: Array<{ name?: string; run?: string }> } };
  };
  // Match steps by name, not by index. Adding a step ahead of an existing one
  // silently re-points `runs[0]` at the wrong block, and the test then reports
  // a failure in the block it never ran.
  const named = (needle: string): string => {
    const hit = wf.jobs.automerge.steps.find(
      (s) => (s.name ?? '').toLowerCase().includes(needle) && s.run,
    );
    expect(hit?.run, `no step named like "${needle}"`).toBeTruthy();
    return hit?.run as string;
  };
  return {
    resolve: named('resolve the pull request'),
    policy: named('read required checks'),
    merge: named('merge when every required check'),
  };
}

/** Wrap a value for `jq -r '<expr>'` style single quoting in bash. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Run the "resolve the pull request" step with a stub `gh`.
 *
 * A `schedule` run carries no payload at all, so the step has to find the PR
 * itself and read its head SHA back. The stub answers only what the step asks.
 */
function runResolve(args: {
  event: 'pull_request_target' | 'schedule';
  openPrs: Array<{ number: number; state: string }>;
  draftFor: Record<number, boolean>;
  headSha?: string;
}): { r: SpawnSyncReturns<string>; outFile: string; calls: string[] } {
  const binDir = tmp('memphis-gh-');
  const ghPath = path.join(binDir, 'gh');
  const callsFile = path.join(tmp('memphis-ghcalls-'), 'calls');
  const prs = JSON.stringify(args.openPrs);
  const draftPrs = JSON.stringify(
    Object.entries(args.draftFor).map(([number, draft]) => ({ number: Number(number), draft })),
  );
  const headSha = args.headSha ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  // The stub must behave like `gh api --jq <expr>`, not like a raw HTTP
  // endpoint, and it must answer each route with the shape that route really
  // returns: /commits/:sha/pulls is a LIST, /pulls/:n is ONE object. A stub
  // that flattens both makes the step die on a jq error before it reaches its
  // decision — the test goes red for a reason that has nothing to do with the
  // branch under test.
  //
  // The script lives in its own file rather than a template literal so the shell
  // inside it needs no escaping at all.
  const stub = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
    'expr=""; prev=""',
    'for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done',
    // The LIST route carries `draft` on every entry, because that is the field
    // the step filters on. Handing it a list without `draft` makes
    // `select(.draft == false)` drop every row: the job reports "nothing open"
    // while pull requests are open — a refusal for the wrong reason that would
    // still show green.
    `prs=${shellSingleQuote(prs)}`,
    `drafts=${shellSingleQuote(draftPrs)}`,
    'prsWithDraft="$(printf %s "$prs" | jq -c --argjson d "$drafts" \'[.[] | {number, state, draft: ($d | map({key: (.number|tostring), value: .draft}) | from_entries)[(.number|tostring)] // false}]\')"',
    `drafts=${shellSingleQuote(draftPrs)}`,
    `HEAD_SHA=${JSON.stringify(args.headSha ?? 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')}`,
    'case "$*" in',
    '  *state=open*) data="$prsWithDraft" ;;',
    '  *commits/*/pulls*) data="$prs" ;;',
    '  */pulls/*)',
    '    n="$(printf %s "$*" | sed -n "s|.*/pulls/\\([0-9]*\\).*|\\1|p")"',
    '    obj="$(printf %s "$drafts" | jq -c --arg n "$n" \'map(select((.number|tostring) == $n))[0] // {}\')"',
    '    data="$(printf %s "$obj" | jq -c --arg h "$HEAD_SHA" \'{number: .number, draft: .draft, head: {sha: $h}}\')"',
    '    ;;',
    '  *) exit 1 ;;',
    'esac',
    'printf %s "$data" | jq -r "$expr"',
  ].join('\n');
  writeFileSync(ghPath, stub + '\n', 'utf8');
  chmodSync(ghPath, 0o755);

  const outFile = path.join(tmp('memphis-out-'), 'gh_output');
  const r = spawnSync('bash', ['-c', steps().resolve], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'Memphis-Chains/memphis',
      GITHUB_OUTPUT: outFile,
      GITHUB_EVENT_NAME: args.event,
      SHA: headSha,
      // The pull_request_target branch interpolates the number directly.
      PR_NUMBER: '4242',
    },
    encoding: 'utf8',
  });
  // No `gh` call means no log file. That is the point on the
  // `pull_request_target` path: the number comes from the event payload, so
  // nothing is looked up and nothing can be looked up wrongly.
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n') : [];
  return { r, outFile, calls };
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

describe('automerge — the scheduled retry has to find its own pull request', () => {
  it('takes the newest open pull request', () => {
    // Oldest-first would leave the newest PR waiting behind every older one,
    // so the retry would pass over the PR that was just fixed.
    const { r, outFile } = runResolve({
      event: 'schedule',
      openPrs: [
        { number: 660, state: 'open' },
        { number: 669, state: 'open' },
      ],
      draftFor: { 669: false },
    });
    expect(r.status).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toContain('number=669');
  });

  it('skips drafts and takes the newest that is not one', () => {
    const { outFile } = runResolve({
      event: 'schedule',
      openPrs: [
        { number: 661, state: 'open' },
        { number: 669, state: 'open' },
      ],
      draftFor: { 669: true, 661: false },
    });
    expect(readFileSync(outFile, 'utf8')).toContain('number=661');
  });

  it('stops when nothing is open', () => {
    const { r, outFile } = runResolve({
      event: 'schedule',
      openPrs: [{ number: 659, state: 'closed' }],
      draftFor: {},
    });
    expect(`${r.stdout}${r.stderr}`).toContain('No mergeable pull request');
    expect(existsSync(outFile)).toBe(false);
  });

  it('refuses when the PR head SHA cannot be read', () => {
    // Without a commit to inspect the required-check step would query an empty
    // SHA and read it as "no checks reported", which is the same verdict as a
    // green run. Failing is the honest direction.
    const { r } = runResolve({
      event: 'schedule',
      openPrs: [{ number: 670, state: 'open' }],
      draftFor: { 670: false },
      headSha: '',
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('refusing');
  });

  it('uses the payload number on pull_request_target', () => {
    const { r, outFile, calls } = runResolve({
      event: 'pull_request_target',
      openPrs: [],
      draftFor: {},
    });
    expect(r.status).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toContain('number=4242');
    // The number comes from the payload — no lookup by commit, because that is a
    // second source that can disagree with the event. Exactly one call remains:
    // the draft check, which the payload does not carry.
    const made = calls.filter(Boolean);
    expect(made).toHaveLength(1);
    expect(made[0]).toContain('/pulls/4242');
    expect(made[0]).not.toContain('commits/');
  });
});
