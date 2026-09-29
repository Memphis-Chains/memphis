# weekly-runtime-kpi workflow fails on `issues.create` — 403 "Resource not accessible by integration"

## Severity
**High** — scheduled workflow that publishes weekly runtime KPI fails on every run, 3 consecutive failures today (2026-09-21 09:11, 13:41, 15:09 CEST). Visible in repo's Actions tab, breaks the operational signal chain.

## Observed

```
gh run view 35617071010 --log-failed
...
[@octokit/request] "POST https://api.github.com/repos/Memphis-Chains/memphis/issues" is deprecated.
RequestError [HttpError]: Resource not accessible by integration
  status: 403,
  response.headers['x-accepted-github-permissions']: 'issues=write'
  response.data: { message: 'Resource not accessible by integration', status: '403' }
```

Workflow: `.github/workflows/weekly-runtime-kpi.yml`
Step: "Compute and publish weekly KPI"
Action: `actions/github-script@v7`
Call: `github.rest.issues.create({ owner, repo, title, body })`

The token in use does not have `issues: write` permission on the repo. GitHub explicitly tells us which permission *would* satisfy the call: `x-accepted-github-permissions: issues=write`.

## Why PR #636 didn't fully fix it

PR `fix/weekly-runtime-kpi-issues-permission` (latest commit `0a3208d` on branch `fix/weekly-runtime-kpi-issues-permission`, 2026-09-21 15:41 CEST) sets:

```yaml
permissions:
  issues: write
```

on the workflow level. **However** the `workflow_dispatch` runs against `main` and the *scheduled* trigger (`schedule:` cron) does the same — both still 403 at 15:10:03 today. Reading the YAML locally is needed to confirm whether `permissions:` is scoped to `pull_request:` only (typical pattern when a workflow handles both PR and schedule), or whether the `GITHUB_TOKEN` used in the scheduled run is a different token than the one in PR context.

## Repro

```bash
gh workflow run weekly-runtime-kpi.yml
gh run list --workflow=weekly-runtime-kpi.yml --limit 3
gh run view <id> --log-failed | grep -A2 'Resource not accessible'
```

Repro is 100% on schedule and on `workflow_dispatch`. Not a flake.

## Expected

`github.rest.issues.create` succeeds, issue gets posted (or existing one gets a new comment), workflow exits 0.

## Actual

`HttpError 403 Resource not accessible by integration`, workflow exits 1.

## Investigation plan (tier-2 read-only)

1. **Read the workflow file** `.github/workflows/weekly-runtime-kpi.yml` — confirm where `permissions:` is declared (workflow-level vs job-level vs step-level).
2. **Check GitHub Settings → Actions → General → Workflow permissions** for the repo. If it is set to "Read repository contents and packages permissions", scheduled runs will use that read-only token regardless of what `permissions:` says in the YAML — because the YAML override only applies to GITHUB_TOKEN issued by the runner, and the scheduled token can be subject to repo-level cap.
3. **Compare to other workflows that successfully create issues** (e.g. automerge, dependabot) — see how they declare permissions. Likely they are PR-triggered and inherit a token with `issues: write` from the PR author, while the schedule trigger gets the default repo token.
4. **Test fix candidates**:
   - (a) Move `permissions: { issues: write }` to job-level rather than workflow-level.
   - (b) Use a `GH_PAT_FOR_ISSUES` secret (fine-grained PAT with `issues:write` on this repo) instead of `secrets.GITHUB_TOKEN`.
   - (c) Configure repo-level "Workflow permissions: Read and write permissions" in Settings → Actions → General.

The cleanest fix is probably (b) — a fine-grained PAT stored as a repo secret — because:
- it survives repo permission changes,
- it does not require changing Settings (admin-only operation, slower to deploy),
- it works identically for `schedule`, `workflow_dispatch`, and `pull_request` triggers.

## Acceptance criteria

- Manual `gh workflow run weekly-runtime-kpi.yml` succeeds and creates/updates the KPI issue.
- Next scheduled run (cron: see YAML) succeeds.
- CI smoke-test added: a minimal `schedule:` workflow that calls `issues.create` on a test issue, runs against a dummy repo, asserts 200/201. (Optional, only if cheap.)

## Workaround

None today. KPI reporting is broken until fix lands.

## Owner

@memphis-runtime maintainers.

## Labels

`bug`, `ci`, `workflow`, `tier-2-blocker`, `scheduled-runner`
