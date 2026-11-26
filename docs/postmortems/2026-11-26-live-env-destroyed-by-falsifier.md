# An agent's falsifier deleted the runtime's `.env` and took the service down — 2026-11-26

**Status:** monitoring
**Severity:** S2 (the runtime was down for ~40 minutes; no data was lost, but one irreplaceable key was one `rm` away from being lost with it)
**Open items:** 4

## Summary

On 2026-11-26, in the same session that scrubbed the published history, a
falsifier for the new forbidden-path gate was run against the **live**
configuration file instead of a scratch path.

The sequence was three ordinary commands:

```
printf 'MEMPHIS_VAULT_PEPPER=...' > .env     # wrote to the live file
git add .env                                  # rejected it — the path is gitignored
rm -f .env                                    # deleted it
```

The middle command was supposed to stop the sequence. It did — but only for
the wrong reason, and silently: `.env` is in `.gitignore`, so `git add` refused
the path with a message that looked like a normal ignore notice rather than a
refusal. The write had already happened, and the `rm` was the third command in
a list someone had mentally filed under "temporary scratch files".

`memphis.service` then failed to start. systemd cannot start a unit whose
`EnvironmentFile=` is missing:

```
Failed to load environment files: /home/memphis/memphis/.env: No such file or directory
Failed to spawn 'start-pre' task
```

The unit went to `failed` with `NRestarts=5`.

The interesting part is not the outage. It is that **the one value that could
not be regenerated was one `rm` away from being gone**: the vault pepper. It
lives in exactly one file, it is the key every vault entry is encrypted under,
and no backup on this host contains it — `scripts/backup-exclude-policy.json`
excludes `.env` from every archive, deliberately, and correctly.

## Timeline

- **2026-11-26, ~19:45** — the falsifier writes its payload to the live
  `/home/memphis/memphis/.env`. The gate under test is fine; the way it was
  exercised was not.
- **2026-11-26, 19:45** — `git add .env` rejects the path (gitignored). The
  write is already on disk.
- **2026-11-26, 19:45** — `rm -f .env` removes the operator's configuration
  file. The runtime has no `.env` from this moment on.
- **2026-11-26, 19:4x–20:0x** — `memphis.service` restarts and fails.
  `NRestarts=5`, `ActiveState=failed`. The boot-failure gate (>5 in 10 min →
  exit 102) never fired — the failure mode was systemd refusing to load the
  environment file, not the daemon crashing.
- **2026-11-26, 20:0x** — the service is stopped deliberately so the file can
  be rebuilt without a restart loop.
- **2026-11-26, 20:1x–20:3x** — recovery is measured, not guessed:
  - the env transaction journal (`/home/memphis/memphis/.env.transactions/journal.sqlite`)
    is **empty** — no `previous` row to roll back to;
  - every archive on the host was listed and checked: **no `.env`** in any of
    them, because the backup policy excludes it;
  - the three historical peppers in the pre-scrub git backup (lengths 18 and 64) do **not** unwrap the live vault state — the pepper in use was never
    in the published history;
  - `~/.memphis/vault-state.json` has not been rewritten since 2026-07-13, so
    the pepper that opens it is the one that was in the destroyed file.
- **2026-11-26, 20:3x** — the pepper is recovered from the operator's own chat
  history in `data/memphis.db`, and selected **by proof**: a candidate counts
  only when it unwraps `vault-state.json` _and_ decrypts every entry. Exactly
  one candidate decrypts **17/17** entries.
- **2026-11-26, 20:3x** — a vault recovery bundle is sealed
  (`/home/memphis/runtime-archives/vault-recovery-2026-11-26/`) _before_ any
  reinstall, because the setup wizard initialises a new vault and
  `vault init --force` overwrites both vault files irrecoverably.
- **2026-11-26, 20:37** — `.env` is rebuilt (0600, via the repository's own
  `writePrivateAtomicFile`), the API token is reissued, the service starts.
- **2026-11-26, 20:38** — measured after the restart: `ActiveState=active`,
  `NRestarts=0`; `memphis health` → `status: ok`, `vaultInitialized: true`;
  `memphis doctor` → 61 checks, 48 pass, 13 warn, **0 fail**; `memphis chain
verify` → `ok: true`, 14 chains, 12 840 blocks; the Telegram channel gateway
  comes up with provider `openai` / model `astra-gtp6-max` — the same pair the
  daemon logged before the outage; an authenticated HTTP request with the new
  token returns 200.

## Impact

**Severity S2.** The runtime was down for roughly 40 minutes. No chain block,
no vault entry and no scheduled job was lost. The Telegram surface, the HTTP
API and the MCP server were unavailable in the meantime, and the operator's
API token was invalidated — it had to be reissued.

The near-miss is the real cost. One file, one key, and 17 entries whose
plaintext exists nowhere else: the MiniMax key, the Telegram bot token, the
GitHub PAT, the DID seed, the internal docs password, the stats token and nine
memory archives. Had the pepper not been recoverable from the operator's chat
history, a single `rm -f` would have destroyed all of them — permanently, and
with no backup to restore from, because the backup policy is right to exclude
`.env`.

## Root cause

**The test wrote into the system under test.** The falsifier's whole job is
to prove that the gate rejects a forbidden path, and it did that by creating
the forbidden path — at the one location where creating it is destructive. A
falsifier that has to be pointed at a live path is a falsifier that will, one
day, be pointed at a live path.

Two smaller failures compounded it:

1. **`git add` looked like a safety net and was not.** The rejection came
   from `.gitignore`, not from any gate, and it came out in the shape of an
   ordinary notice. The `rm` that followed was not connected to it by anything
   in the transcript.
2. **The pepper had exactly one home.** One file, on one disk, with no
   off-host copy and no copy in any archive.

## What made the recovery possible

- The vault's master key is wrapped under `scrypt(pepper)` + AES-256-GCM, and
  the wrap survives independently of the entry store. That is what made
  "recover the pepper, get everything back" possible.
- The operator's chat history in `data/memphis.db` retained the pepper. It
  was never written to a place the backup policy protects, because it was
  never treated as a secret worth protecting there — it was a message.
- Selection by proof rather than by pattern: 15 text candidates, 1 that
  decrypts 17/17 entries.

## Open items

- [ ] The pepper still has exactly one home. Put it in the operator's password manager (off-host) so that a lost `.env` costs minutes instead of a recovery procedure.
- [ ] Add a guard so that a test or a script cannot write a `.env` into the install root: a check that refuses any write to `<installRoot>/.env` outside the operator's explicit configuration path.
- [ ] `MEMPHIS_API_TOKEN` was reissued (32 chars, `generateSecureToken`). Any client outside this host that holds the previous token has to be updated by the operator.
- [ ] `builtin-runtime-watch` has reported "last turn failed, last provider call failed" every 15 minutes since 15:45 on 2026-11-26 — four hours BEFORE this outage. It is a separate, pre-existing failure and it is still open.
