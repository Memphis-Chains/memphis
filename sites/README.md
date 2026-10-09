# sites/ — one way to manage the whole web estate

Three domains, one shared hosting account, one repo. This directory is the
source of truth; the server is a deployment target, never an editor.

```
sites/
├── estate.json            the registry: what exists, what is server-owned
├── README.md              this file
├── scripts/
│   ├── sites-sync.sh      pull / push / diff against production
│   ├── sites-health.sh    audit every site, exit 1 on a leak
│   └── leakscan.py        the leak detector (used by sites-health.sh)
├── marcin-kukla/          master for marcin-kukla.pl
├── holiskool/             master for holiskool.pl
└── memphis-v5/            master for memphis-v5.pl (public static only)
```

## Setup

Both scripts need two variables. `SITES_SSH_CONFIG` is an ssh config file that
defines the host alias; pass it rather than hardcoding a key path:

```bash
export SITES_SSH_HOST=lhpl
export SITES_SSH_CONFIG=/path/to/lhpl-active/config
```

## The rule that removes a whole class of accidents

**Never edit production directly. Never `rsync` a directory into a docroot.**

The old setup kept mirrors outside the repo, so no history, no review, no
freshness guarantee. One was five weeks stale. Publishing from it would have
replaced a working homepage with an older version and silently dropped the
Calendly call-to-action.

The estate now has one master per site, in the repo, and the flow is:

```bash
sites/scripts/sites-sync.sh --list              # what exists (no SSH needed)
sites/scripts/sites-sync.sh --diff marcin-kukla # per-file comparison
sites/scripts/sites-sync.sh --pull marcin-kukla # adopt production as the master
# ... edit sites/marcin-kukla/ ... commit ...
sites/scripts/sites-sync.sh --push marcin-kukla # drift gate, then publish
sites/scripts/sites-health.sh                   # audit everything
```

`--pull` is how a site joins the repo: fetch production first, so the master
starts as a byte-exact copy and nothing is lost. `--push` refuses to run when
production moved since the last pull.

## Before publishing

```bash
sites/scripts/sites-health.sh --json
```

Exit 0 means no leak. Exit 1 means a public working artifact — fix it before
shipping anything else. The audit is read-only; run it as often as you like.

## Publishing

Not automated on purpose. Every publish is:

1. `sites-sync.sh --push <site>` — drift gate, read-only
2. `cp public_html/<site>/<file> ~/site-backups/<site>/<file>.<ts>.bak`
3. `scp` the file, one at a time
4. `curl` the URL back and confirm the content changed
5. `sites-health.sh <site>` — confirm no new finding

New files go up first (they cannot break anything); then `.htaccess`, last.
A syntax error in `.htaccess` takes the whole site down, so it is always the
last thing written and always backed up first.

## What is server-owned

`memphis-v5.pl` also hosts live applications that are **not** in the repo and
must never be synced over:

| Path | What |
|---|---|
| `panel-app/` | Laravel + Filament application, database, env file |
| `panel/` | webroot of that application |
| `docs/` | generated documentation site |
| `data/` | SQLite analytics database and the HMAC salt |

`api/` was on this list until 2026-10-09 and is now **repo-owned**: the only git
copy of the PHP backend lives in `sites/memphis-v5/api/`, and one `git clean` used
to destroy it. It stays excluded from `--pull` so the server's copy can never
overwrite the repo's, and `rsync --delete` leaves excluded paths alone (measured,
not assumed).

The remaining ones are listed in `estate.json` under `serverOwnedNeverRsync`.
`sites-sync.sh --pull` excludes them; `--push` prints them so the exclusion is
visible rather than silent.

One asymmetry worth knowing: `--push` is an rsync **without** `--delete`, so it
would overwrite `data/site.db` if the master ever held one. It does not, and that
is the only thing protecting the production database — not a guard.

## Leak detection

The interesting question is not "does this filename look suspicious". It is
**is this file readable that we never meant to publish**.

Turning off directory listings does not hide contents — a bare directory returns
403 while every file inside returns 200. Three full copies of an old page sat
behind a 403 for weeks that way.

So `leakscan.py` crawls the site from the home page, following `href`/`src`,
`sitemap.xml`, and CSS `url()`, and treats everything it reaches as published.
A docroot file that answers 200 but was never reached is a finding — graded:

- **BLOCK** — backups, editor swap files, env files, keys, logs, databases,
  anything inside a working directory such as `.memphis-snapshots/`. Nobody
  intended to publish these.
- **warn** — readable but unreached. Often fine (an asset only referenced from
  CSS, an intentionally unlinked page). Sometimes a real content leak. The
  scanner cannot tell them apart and does not pretend to.

A filename rule cannot do this. "Every `.html` is suspicious" reports 42 false
positives on a real site, because every page is an `.html` file. And an editor
swap file named `.index.html.swp` matches no extension glob at all — it was
served verbatim, and only probing both URL shapes found it.

## Anti-confab

| Rule | Why |
|---|---|
| Back up before writing, outside the docroot | No git on the server. The backup is the only way back. |
| Never leave a backup inside the docroot | It is public. Five old page versions were readable by anyone. |
| One file at a time, verify between | Otherwise you cannot tell which change broke it. |
| `.htaccess` last, always | A syntax error takes down every page on the site. |
| Only touch `public_html/<site>/` for your site | Other people's projects share the account. |
| Never `rsync --delete` a docroot | It would delete the server-owned applications above. |
| Never judge a failure from one request | A checker of mine reported a live page as 404; 20 sequential requests all returned 200. The bug was in my loop. |
| Measure before tuning a timeout | A short timeout looked like flakiness. Measured: a trivial command passed, a directory listing failed. The timeout was reporting command length, not reachability. |

## Notes

- Established 2026-10-09 after an audit found three live page copies readable on
  marcin-kukla.pl, two sites with no repo master at all, and a deploy script
  that would have published five-week-old files and created two stray
  directories on the server.
- The SSH link to the server drops connections often. Both scripts retry and
  never infer "unreachable" from a single timeout.