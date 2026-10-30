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
function steps(): { resolve: string; policy: string; sync: string; merge: string } {
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
    sync: named('behind pull request'),
    merge: named('merge when every required check'),
  };
}

/** Wrap a value for `jq -r '<expr>'` style single quoting in bash. */
/** The four check contexts the `main` ruleset requires, read at runtime by the
 *  workflow rather than hardcoded there. Listed here so the tests assert
 *  against the same set — measured from GET /rules/branches/main, 2026-10-10. */
const CHECK_NAMES = [
  'chain-invariant',
  'cross-arch (macos-latest)',
  'cross-arch (ubuntu-24.04-arm)',
  'quality-gate',
];

/** An obviously fake commit id, used wherever the stub needs something to
 *  return without any test asserting on its value. */
const DEFAULT_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

/** The head commit an updated branch reports back. */
const NEW_SHA = 'c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00';

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
  event: 'pull_request_target' | 'schedule' | 'workflow_dispatch';
  openPrs: Array<{ number: number; state: string }>;
  draftFor: Record<number, boolean>;
  headSha?: string;
}): { r: SpawnSyncReturns<string>; outFile: string; calls: string[] } {
  const binDir = tmp('memphis-gh-');
  const ghPath = path.join(binDir, 'gh');
  const callsFile = path.join(tmp('memphis-ghcalls-'), 'calls');
  const headSha = args.headSha ?? DEFAULT_SHA;

  // The stub answers each route with the shape that route really returns:
  // `/pulls?state=open` and `/commits/:sha/pulls` are LISTS that carry `draft`
  // on every entry, `/pulls/:n` is ONE object. A stub that flattens them, or
  // omits `draft`, makes the step die on a jq error or silently drop every row
  // — a refusal for the wrong reason, which is the direction tests are least
  // able to catch.
  //
  // All of that data is built here with JSON.stringify and embedded in the
  // script through shellSingleQuote. An earlier version assembled `jq` programs
  // inside the shell strings instead, escaping quotes into a TypeScript
  // literal: `\'` is a backslash followed by a quote, the shell does not read
  // that as a quote, the next line runs on, and jq receives one expression with
  // a `//` in the wrong place. It passed locally and failed on the runner.
  const listJson = JSON.stringify(
    args.openPrs.map((pr) => ({
      number: pr.number,
      state: pr.state,
      draft: args.draftFor[pr.number] ?? false,
    })),
  );
  const objectsJson = JSON.stringify(
    Object.keys(args.draftFor).map((n) => ({
      number: Number(n),
      draft: args.draftFor[Number(n)] ?? false,
      head: { sha: headSha },
    })),
  );

  const stub = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
    'expr=""; prev=""',
    'for a in "$@"; do [[ "$prev" == "--jq" ]] && expr="$a"; prev="$a"; done',
    `objects=${shellSingleQuote(objectsJson)}`,
    'case "$*" in',
    `  *state=open*|*commits/*/pulls*) data=${shellSingleQuote(listJson)} ;;`,
    '  */pulls/*)',
    '    n="$(printf %s "$*" | sed -n "s|.*/pulls/\\([0-9]*\\).*|\\1|p")"',
    `    data="$(printf %s "$objects" | jq -c --arg n "$n" ${shellSingleQuote(
      'map(select((.number|tostring) == $n))[0] // {}',
    )})"`,
    '    ;;',
    '  *) exit 1 ;;',
    'esac',
    'printf %s "$data" | jq -r "$expr"',
  ].join('\n');

  writeFileSync(ghPath, `${stub}\n`, 'utf8');
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
      PR_NUMBER: '4242',
    },
    encoding: 'utf8',
  });
  // No `gh` call means no log file. That is the point on the
  // `pull_request_target` path when the number comes from the payload and the
  // step returns before the draft check; the case that asserts zero calls
  // covers a step that genuinely never asks.
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n') : [];
  return { r, outFile, calls };
}
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

function runMerge(
  verdicts: string,
  required = CHECK_NAMES.join(','),
  opts: { headUpdated?: string } = {},
) {
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
      HEAD_UPDATED: opts.headUpdated ?? '',
    },
    encoding: 'utf8',
  });
}

/**
 * Run the "bring a behind pull request up to date" step with a stub `gh`.
 *
 * The stub answers two routes and refuses everything else:
 *
 *   repos/OWNER/REPO/pulls/N          -> the mergeable_state of the PR
 *   repos/OWNER/REPO/pulls/N/update-branch -> the new head, or a refusal
 *
 * The refusal is the case that was measured on PR #708: the head lives in a
 * fork that this token can only read, so the update is refused by the API and
 * the pull request cannot be merged until somebody else moves it.
 */
function runSync(args: { state: string; updateOk: boolean }): {
  r: SpawnSyncReturns<string>;
  outFile: string;
  calls: string[];
} {
  const binDir = tmp('memphis-sync-');
  const ghPath = path.join(binDir, 'gh');
  const callsFile = path.join(tmp('memphis-synccalls-'), 'calls');
  const stub = [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "$*" >> ${JSON.stringify(callsFile)}`,
    'case "$*" in',
    '  *update-branch*)',
    args.updateOk
      ? `    printf '%s\\n' "${NEW_SHA}"; exit 0 ;;`
      : '    echo "gh: Resource not accessible by integration (HTTP 403)" >&2; exit 1 ;;',
    '  *pulls/*)',
    `    printf '%s\\n' ${shellSingleQuote(args.state)}; exit 0 ;;`,
    'esac',
    'exit 1',
  ].join('\n');
  writeFileSync(ghPath, stub, 'utf8');
  chmodSync(ghPath, 0o755);

  const outFile = path.join(tmp('memphis-out-'), 'gh_output');
  const r = spawnSync('bash', ['-c', steps().sync], {
    cwd: repoRoot,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GH_TOKEN: 'test',
      GITHUB_REPOSITORY: 'Memphis-Chains/memphis',
      GITHUB_OUTPUT: outFile,
      PR_NUMBER: '999',
    },
    encoding: 'utf8',
  });
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n') : [];
  return { r, outFile, calls };
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
    // Guard: if the step wrote nothing, print why. A bare ENOENT on the output
    // file says nothing about which of the stub, the API shape, or the filter
    // was wrong, and this exact test passed locally while failing on CI.
    const failWithStep = (r: SpawnSyncReturns<string>) => {
      throw new Error(
        `step produced no output.\nstatus=${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`,
      );
    };
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
    if (!existsSync(outFile)) failWithStep(r);
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

  it('resolves its own pull request on a manual run', () => {
    // A manual run carries no pull request at all — not even a null one. The
    // step used to fall through to the payload branch, found no number, and
    // exited 1 with "No pull request number in the event payload", which is
    // exactly the message you get when the manual button cannot do the one
    // thing it exists for.
    const { r, outFile } = runResolve({
      event: 'workflow_dispatch',
      openPrs: [
        { number: 670, state: 'open' },
        { number: 675, state: 'open' },
      ],
      draftFor: { 675: false },
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('Manual run');
    expect(readFileSync(outFile, 'utf8')).toContain('number=675');
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

describe('automerge — a pull request behind the base branch', () => {
  it('updates the head and waits for the checks on the new head', () => {
    // The update creates a new head commit, so the verdicts read on the old
    // head describe a commit that is no longer the head. The step says so and
    // lets the next scheduled run merge.
    const { r, outFile, calls } = runSync({ state: 'behind', updateOk: true });
    expect(r.status).toBe(0);
    expect(readFileSync(outFile, 'utf8')).toContain('updated=true');
    expect(calls.join('\n')).toContain('update-branch');
  });

  it('refuses with the two things that would fix it when the head cannot be updated', () => {
    // PR #708: the head lives in a fork this token can only read. The old
    // workflow said "Pull request is not mergeable: the head branch is not up
    // to date with the base branch" and exited 1, every five minutes, with
    // nothing in the message about the cause.
    const { r } = runSync({ state: 'behind', updateOk: false });
    expect(r.status).not.toBe(0);
    const said = `${r.stdout}${r.stderr}`;
    expect(said).toContain('could not be updated');
    expect(said).toContain('write access to the head repository');
  });

  it('does not touch the branch when the head is current', () => {
    const { r, outFile, calls } = runSync({ state: 'clean', updateOk: true });
    expect(r.status).toBe(0);
    expect(calls.join('\n')).not.toContain('update-branch');
    expect(existsSync(outFile)).toBe(false);
  });

  it('does not merge on verdicts that describe a head that has moved', () => {
    // The merge step must refuse when the sync step moved the head. Merging
    // on the old verdicts would merge a commit nobody checked.
    const r = runMerge(verdictsFor(), CHECK_NAMES.join(','), { headUpdated: 'true' });
    expect(r.stdout).toContain('The head moved');
    expect(r.stdout).not.toContain('MERGE-CALLED');
  });

  it('still merges when the head did not move', () => {
    const r = runMerge(verdictsFor(), CHECK_NAMES.join(','), { headUpdated: '' });
    expect(r.stdout).toContain('MERGE-CALLED');
  });
});
