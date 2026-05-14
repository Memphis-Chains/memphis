# P0: `memphis init` must refuse to overwrite non-empty vault state

## Why this matters

On 2026-05-13 at 00:25 CEST the daemon entered crashloop with `Vault integrity probe failed — 3 of 3 entries fail decrypt → exit 102`. Root cause: silent vault re-init between 2026-05-11 15:57 and 16:07 left `vault-state.json` with a new master-key envelope (different salt + encryptedMasterKey + iv + tag) while `vault-entries.json` retained 3 entries encrypted under the **old** key. By the time daemon next started, the integrity probe could not decrypt any entry.

The fix in PR #584 closed only the **cache-invalidation flavor** of pepper desync. This is the **silent-re-init flavor** — distinct, real, and unprevented by current code. Today required a full clean reset: backup → move vault aside → operator runs `memphis init` again → re-add all 3 secrets manually → restart. ~30 min downtime.

Per memory `feedback_pepper_desync_twice_same_day.md` (updated 2026-05-13): this incident class will replay until `vault init` refuses to overwrite a non-empty entries file.

## Acceptance

`memphis init` invoked when `~/.memphis/vault-entries.json` exists and is non-empty:

- **Without `--force-reinit`**: throws clear error explaining that re-init would render existing entries undecryptable; suggests `memphis vault list` to see current entries + `memphis operator recover` if passphrase is lost. Exit non-zero. **Does not touch any file.**
- **With `--force-reinit`**: proceeds as today (full re-init) AFTER appending an audit event `vault.init.force-reinit` recording the prior entries count + their fingerprints (no plaintext). Operator-passphrase auth required for `--force-reinit` to prevent drive-by clobber.

## Scope

**In:**

- `src/infra/cli/handlers/vault.handler.ts` — `handleVaultInit` (~line 130-170): pre-check `existsSync(vaultEntriesPath)` AND parse the file to confirm `entries.length > 0` before proceeding; gate behind `--force-reinit`.
- `src/infra/cli/parser.ts` — register `--force-reinit` boolean flag.
- `tests/cli/vault-init-refuse-nonempty.test.ts` (NEW):
  - Test 1: non-empty entries.json + no `--force-reinit` → throws, files unchanged
  - Test 2: non-empty entries.json + `--force-reinit` → proceeds, audit event emitted with prior count + fingerprints
  - Test 3: empty entries.json (fresh install) + no flag → proceeds (today's behavior preserved)
  - Test 4: missing entries.json + no flag → proceeds (today's behavior preserved)

**Out (defer to separate PR if needed):**

- TUI `/vault init` surface — wait until P0 lands in CLI first
- `memphis init` wizard refactor — keep narrow

## Cross-layer grid

| Rust core | NAPI | TS host | CLI | TUI | Doctor | Tests |
|-----------|------|---------|-----|-----|--------|-------|
| – | – | ✅ | ✅ | – | optional surface "vault re-init blocked" | ✅ MUST |

## Memory hooks

- `feedback_pepper_desync_twice_same_day` — silent re-init flavor is REAL, not phantom
- `feedback_truth_model_silent_catch` — surface the cause; don't swallow the check
- `feedback_codex_bundled_hotfix` — Codex round-2 bundle if review surfaces issues
