# Runtime Issues Found During Fresh Local Setup

Updated: 2026-04-09

This document captures concrete runtime issues encountered during a fresh local Memphis install/bootstrap on Ubuntu user-session systemd with Telegram enabled. These should be converted into first-class GitHub Issues when issue-creation tooling is available.

No matching open issues were found in a quick repo search for the items below on 2026-04-09.

## 1. Default port `3000` can collide with unrelated local services and trap `memphis.service` in a restart loop

Suggested issue title:
`service install succeeds but runtime crash-loops on EADDRINUSE when 127.0.0.1:3000 is already taken`

Observed behavior:
- `memphis service install` reports the unit as installed and active
- `systemctl --user status memphis.service` can briefly look healthy
- journal shows repeated restart attempts
- runtime exits with `listen EADDRINUSE: address already in use 127.0.0.1:3000`
- Telegram inbound never works because the long-running gateway never stays up

Observed local detail:
- another local service was already serving HTTP on `127.0.0.1:3000`
- Memphis only became deployable after moving `PORT` off `3000`

Expected behavior:
- service install / setup should detect the collision before enabling the unit
- the operator should get a clear remediation path, ideally with the conflicting listener identified
- health/status should not imply success while the service is crash-looping

Good fixes:
- preflight port availability check in setup/service install
- clearer service-status output for restart loops
- optional automatic fallback to a free port, or explicit prompt to select one

## 2. Telegram allowlist failure mode is opaque: bot is alive but replies only with `Access denied`

Suggested issue title:
`telegram onboarding does not help operators discover the correct allowlist user/chat id`

Observed behavior:
- Telegram bot token is valid
- outbound `telegram send` works once the token is correct
- inbound messages reach the bot, but it answers only `Access denied`
- current UX does not make it obvious whether the wrong value is a user id, chat id, or stale allowlist entry

Expected behavior:
- setup should expose the detected Telegram sender id/chat id needed for allowlisting
- denied replies should include enough guidance to self-correct safely
- `telegram status` should explain which id type is expected and whether the current sender is blocked

Good fixes:
- `/start` or denied-path diagnostic that echoes the caller id in a safe operator-readable form
- richer `telegram status`
- safer first-run pairing flow for a single operator account

## 3. Fresh install can fail hard when `better-sqlite3` native bindings are missing

Suggested issue title:
`fresh install can leave better-sqlite3 unbuilt, breaking doctor/health/init flows`

Observed behavior:
- CLI/runtime failed with `Could not locate the bindings file`
- exact-search SQLite state was unavailable
- runtime bootstrap and some CLI paths failed until a manual rebuild

Successful workaround:
```bash
rm -rf node_modules
npm install
npm rebuild better-sqlite3 --build-from-source
npm run build
```

Expected behavior:
- bootstrap/install should either build this dependency reliably or fail with an explicit remediation step
- doctor should point directly at the native binding problem

Potential causes worth checking:
- Node 24 compatibility path
- native rebuild not guaranteed during bootstrap on some hosts
- mismatch between install-time and runtime environment

## 4. Rust operator reported vault integrity failure for MiniMax even though the on-disk entry fingerprint matched

Suggested issue title:
`rust operator can report vault integrity failure for valid minimax_api_key entries`

Observed behavior:
- Telegram/runtime path was otherwise healthy
- Memphis chat path returned: `vault entry failed integrity check: minimax_api_key`
- direct inspection of the repo-local vault entries JSON showed a matching integrity fingerprint for `minimax_api_key`
- temporary workaround was to bypass the vault-backed MiniMax lookup for this install

Suspected area:
- Rust operator vault path/state resolution
- relative vs absolute env paths for vault files
- stale runtime state or different vault file than the one inspected

Expected behavior:
- Rust and TS vault readers should resolve the same state files and agree on integrity for the same entry
- errors should include the concrete path being read

## 5. Controlled init can still leave required doctor warnings for `2FA` and `DID`

Suggested issue title:
`doctor still reports required 2FA/DID warnings after controlled-init finishes cleanly`

Observed behavior:
- `memphis init status --json` reported:
  - `state: initialized-clean`
  - `vaultInitialized: true`
  - `operatorConfigured: true`
  - `recordOrigin: controlled-init`
- but `doctor --json` still reported required warnings for:
  - recovery Q&A not configured
  - missing DID identity file

Expected behavior:
- either controlled init should gather/complete these requirements
- or doctor should not frame them as required post-init blockers if the install is already considered canonical and healthy

## 6. Global/linked CLI can lag behind the repo checkout and hide available commands

Suggested issue title:
`linked/global memphis CLI can expose stale help/command registry relative to the local checkout`

Observed behavior:
- user shell `memphis help` did not include `provider add` and `telegram configure`
- local checkout/source contained Telegram handler support and later provider command support in repo history
- this created confusion during setup because documented commands appeared missing

Expected behavior:
- setup/bootstrap should make it obvious which binary is being executed
- linked/global installs should be easier to refresh or verify
- help output should match the runtime actually being launched by service/install docs

## 7. Telegram inbound depends on the long-running service, but the operator can easily think foreground/manual checks are enough

Suggested issue title:
`telegram inbound readiness is not clearly separated from one-shot CLI send/status checks`

Observed behavior:
- `telegram status` could look ready
- direct send succeeded
- bot still did not reply to inbound chat because the long-running Memphis service was not actually staying up

Expected behavior:
- `telegram status` should explicitly verify that the inbound gateway loop is live, not just that the token is valid
- operator guidance should distinguish outbound API reachability from inbound polling readiness

## Recommended follow-up

When issue creation is available, open these as individual GitHub Issues with the suggested titles above and link this document from the issue bodies.
