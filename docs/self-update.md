# Self-update

Sprint 14 added the **release-awareness** half of self-update. Operators
can ask "is there a newer Memphis?" without leaving the CLI; the answer
is also surfaced on `/v1/ops/status` so dashboards can flag stale
installs.

The actual install / rollback mechanics (tarball extraction + symlink
swap under `~/.memphis/versions/`) and GPG signature verification are
deliberately a follow-up — they need to be drilled end-to-end against
real release artifacts with the signing story wired first. Today,
Memphis tells you when to update; you run the existing installer to
do it.

## CLI

```
memphis self-update [check]
```

- `check` (default) — query GitHub for the latest release, compare to
  the local `getAppVersion()`, print the result.

Output (text):
```
update available: 1.3.0 → 1.5.0
```

Output (JSON, via `--json`):
```jsonc
{
  "ok": true,
  "mode": "check",
  "currentVersion": "1.3.0",
  "latestVersion": "1.5.0",
  "updateAvailable": true,
  "release": {
    "tag": "v1.5.0",
    "name": "Memphis 1.5.0",
    "publishedAt": "2026-04-01T12:00:00Z",
    "htmlUrl": "https://github.com/Memphis-Chains/memphis/releases/v1.5.0",
    "tarballUrl": "https://api.github.com/repos/.../tarball/v1.5.0",
    "bodyPreview": "Headline release notes here."
  },
  "checkedAt": "2026-04-13T17:25:00.000Z",
  "summary": "update available: 1.3.0 → 1.5.0"
}
```

`memphis self-update install` and `memphis self-update rollback` print
a clear "not yet implemented; update via GitHub release page" message
so operators don't get a silent no-op.

## HTTP

`GET /v1/ops/status` — adds a top-level `latestVersion` field whose
shape mirrors the JSON above. The field is `null` until the cache
has been populated by the first `memphis self-update check`. **Status
latency never depends on GitHub** — the field reads from a process-
local cache (`peekCachedUpdateResult`); refreshes happen via explicit
`check` calls.

## Caching

Each successful GitHub fetch is cached for `MEMPHIS_UPDATE_CACHE_TTL_MS`
(default 5 min). The default keeps `/status` cheap while bounding the
number of unauthenticated GitHub API calls to ~12/h per process —
under the 60/h unauthenticated rate limit.

## Repository override

For forks or private mirrors:

```
MEMPHIS_UPDATE_REPO_SLUG=YourOrg/your-memphis-fork memphis self-update check
```

## Failure modes

The check **never throws**. Errors land in the `error` field of the
returned result so callers can render them inline:

| Symptom | Likely cause |
|---|---|
| `error: github responded 403` | Unauthenticated rate limit hit. Wait or set repo to one with releases. |
| `error: github responded 404` | Repo slug is wrong, or the repo has no releases yet. |
| `error: malformed github release payload` | GitHub changed the response shape; file an issue. |
| `error: AbortError` | 5 s timeout; check network. |

## What's deliberately not here

- **`--install`** — needs end-to-end drill against real signed
  tarballs and the version-symlink machinery before it's safe to
  expose.
- **`--rollback`** — same; needs `--install` first to leave a known
  prior version.
- **GPG signature verification** — the verification step is wired by
  the same follow-up that adds the actual install path.
- **Conventional-changelog automation** — adjacent to release
  discipline but not on the install path; tracked separately.
