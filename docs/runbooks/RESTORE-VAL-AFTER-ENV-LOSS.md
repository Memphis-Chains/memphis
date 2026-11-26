# RESTORE-VAL-AFTER-ENV-LOSS — what to do when `.env` is gone and the vault is still encrypted

> Authored 2026-11-26, Mavis (minimax-M3).
> Audience: operator (Wodzu) i każdy, kto kiedyś odziedziczy Memphisa.
> Culture: auditable, reversible, vault-first, anty-hubris.

## When this runbook applies

The runtime is down with `Failed to load environment files`, or `.env` is
missing from the install root and the vault refuses to decrypt.

The short version: **the pepper is the vault.** If `MEMPHIS_VAULT_PEPPER` is
lost and nothing else holds it, the vault is unreadable — and no backup on
this host can help, because `scripts/backup-exclude-policy.json` excludes
`.env` from every archive on purpose.

## Order of operations

Do these in this order. The first two are the ones that cannot be undone
later.

### 1. Stop the unit, do not let it restart-loop

```bash
systemctl --user stop memphis.service
systemctl --user show memphis.service -p NRestarts -p ActiveState
```

A unit whose `EnvironmentFile=` is missing fails before the daemon ever
starts, so a restart loop buys nothing and fills the journal with noise.

### 2. Look for a copy BEFORE touching anything

In this order, because each one is cheaper and safer than the next:

| Where                   | How to check                                                                          | Note                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Env transaction journal | `sqlite3 <installRoot>/.env.transactions/journal.sqlite 'select * from transactions'` | Holds the pre-rotation values when a rotation was interrupted. Often empty.                 |
| Vault state journal     | same table under `~/.memphis/vault-state.json.transactions/`                          | Same mechanism, for the vault-side pepper.                                                  |
| Off-host copy           | password manager                                                                      | The only copy that survives losing the disk.                                                |
| Pre-scrub git bundle    | `git log --all -- .env` in a pre-scrub mirror                                         | Contains historical peppers. **These are usually NOT the live one** — check, do not assume. |
| Operator chat history   | `data/memphis.db`, tables `operator_chat_messages` / `operator_turn_checkpoints`      | Where the live pepper was found on 2026-11-26.                                              |

The live pepper is the one that opens `~/.memphis/vault-state.json`. Prove it:

```
scrypt(pepper, "memphis-vault-state-v2", N=16384, r=8, p=1) → AES-256-GCM
  decrypt(encryptedMasterKey ‖ tag, iv) → master key
  master key → AES-256-GCM decrypt every entry in vault-entries.json
```

A pepper that is wrong cannot produce a single readable entry. Use that as the
test; never use "it looks right" as the test.

### 3. Seal the vault before anything that could overwrite it

```bash
install -d -m 700 ~/runtime-archives/vault-recovery-$(date +%F)
install -m 600 ~/.memphis/vault-state.json  ~/runtime-archives/vault-recovery-$(date +%F)/
install -m 600 ~/.memphis/vault-entries.json ~/runtime-archives/vault-recovery-$(date +%F)/
```

Do this BEFORE a reinstall. The setup wizard initialises a **new** vault, and
`memphis vault init --force` overwrites both files irrecoverably. The
ciphertext is only readable under the pepper that is being replaced, so once
the wizard has run, the old entries are gone.

### 4. Rebuild `.env`

The shape of the file is documented in
`~/memphis-restore-tmp/.env-redacted` (the operator's own 2026-09-04 redacted
snapshot) and the accepted keys live in `src/infra/config/schema.ts`.

Rules that matter:

- Write it 0600. Use the repository's own `writePrivateAtomicFile`
  (`src/infra/config/private-atomic-file.ts`) — it is private from creation
  and never truncates the live file.
- Credentials that live in the vault are written as **references**, not
  plaintext: `BRAVE_API_KEY=VAULT:brave_api_key`,
  `MEMPHIS_TELEGRAM_BOT_TOKEN=VAULT:telegram_bot_token`,
  `MINIMAX_VAULT_KEY=minimax_api_key`. The resolved list is
  `VAULT_RESOLVABLE_KEYS` in `src/infra/config/vault-resolve.ts`.
- The pepper is the exception: it IS the vault key, it cannot be referenced.
- `MEMPHIS_API_TOKEN` must be non-empty in production — `validateProductionSafety`
  throws under `MEMPHIS_STRICT_PRODUCTION_SAFETY=1` without it, and the
  daemon compares the token verbatim with no verifier, so a wrong token cannot
  be tested. Reissue with the repository's generator
  (`generateSecureToken` in `src/infra/cli/utils/onboarding-shared.ts`) and
  tell the operator that off-host clients need updating.
- A `VAULT:` reference to an entry that does not exist is only a boot warning,
  but it is a permanent one. Check the entry list before writing the
  reference.

### 5. Start, then measure

```bash
systemctl --user reset-failed memphis.service
systemctl --user start memphis.service
systemctl --user show memphis.service -p ActiveState -p NRestarts
node dist/infra/cli/index.js health
node dist/infra/cli/index.js doctor
node dist/infra/cli/index.js chain verify
```

The runtime is healthy when all of these hold:

- `ActiveState=active`, `NRestarts=0`
- `health` → `status: ok`, `vaultInitialized: true`, `operatorConfigured: true`
- `doctor` → `fail=0`
- `chain verify` → `ok: true`
- the vault-resolved keys read as configured in the env registry coverage line
  (`MEMPHIS_VAULT_PEPPER=<set>`, `BRAVE_API_KEY=<set>`)
- the Telegram channel gateway logs the same provider/model pair it logged
  before the outage

## What never worked, and why it is written down

- **A backup restore cannot fix this.** Every archive excludes `.env`.
- **`git log -- .env` gives the wrong pepper more often than the right one.**
  The published history carried peppers from March 2026; the live one was
  minted later. Test, do not assume.
- **`git add` is not a safety net.** It refused the path because the path is
  gitignored — not because any gate rejected it — and it said so in the shape
  of an ordinary notice.
