# Key Lifecycle

This is the canonical, end-to-end flow for provisioning and operating every
secret Memphis cares about on a single host. If you follow it, you will not
end up with a dead vault or a leaked key. If you skip a step, you will.

There are two passphrases and one pepper. They are separate and they stay
separate. Any time you see a failure involving "vault" and "passphrase" in
the same sentence, the first question is which one.

| Name | What it is | Where it lives | What happens if you lose it |
| --- | --- | --- | --- |
| **Vault pepper** (`MEMPHIS_VAULT_PEPPER`) | 32+ char random string used to wrap the vault master key on disk. | `.env` + off-host backup (password manager). | Vault unrecoverable. No pepper-recovery path exists. |
| **Vault passphrase** | The passphrase you typed at `memphis vault init`. Used together with the recovery Q/A to derive the wrap key. | In your head + (ideally) a password manager. | Use `memphis vault recovery-unlock` to reset the **operator** passphrase; the vault entries themselves are still readable as long as the pepper is intact. |
| **Operator passphrase** | Sudo-like gate for destructive CLI ops. Separate from the vault. | Hashed in `data/config/operator.json`. Recover via Q/A. | Use `memphis vault recovery-unlock` or `memphis operator recover`. |

## 1. Pepper provisioning (one-time, per host)

```bash
openssl rand -hex 32
# → paste into .env as MEMPHIS_VAULT_PEPPER=<value>
```

Also store the value off-host — a password manager entry is fine. Losing the
pepper without a backup means losing every secret in the vault.

## 2. Vault init (one-time)

Interactive (recommended — nothing touches argv or shell history):

```bash
memphis vault init
```

You'll be prompted for:
- Vault passphrase (min 8 chars, shown as `*`)
- Passphrase confirmation
- Recovery question (visible — e.g. "First pet's name?")
- Recovery answer (hidden)

Non-interactive (headless; only use when you can scrub argv afterwards):

```bash
memphis vault init \
  --passphrase '<…>' \
  --recovery-question '<…>' \
  --recovery-answer '<…>'
```

The recovery Q/A unlocks the **operator** passphrase, not the vault pepper.
Do not confuse the two.

## 3. Operator passphrase (each shell)

The operator passphrase gates destructive CLI ops. In a fresh shell, either:

```bash
export MEMPHIS_OPERATOR_PASSPHRASE='<same as operator set>'
```

Or write the passphrase to `~/.memphis/.tier2-passphrase` (mode 0600) for
headless hosts. Never commit either to `.env`.

If you haven't set an operator passphrase yet:

```bash
memphis operator set-passphrase
```

## 4. Provider keys

The vault stores named entries (e.g. `anthropic_api_key`). Providers find
them through one of two env patterns:

- **`*_VAULT_KEY=<entry name>`** — used by `anthropic`, `minimax`, `deepseek`, `glm`.
- **`*_API_KEY=VAULT:<entry name>`** — used by `shared-llm`, `decentralized-llm`, and any adapter that reads the `VAULT:` prefix.

Pick the path that matches how the adapter looks up the key; do not mix them.

### Anthropic — OAuth (recommended)

```bash
memphis auth anthropic
```

Browser flow; stores `anthropic_oauth_refresh_token` and writes
`ANTHROPIC_OAUTH_REFRESH_VAULT_KEY` + `DEFAULT_PROVIDER=anthropic` into
`.env`.

### Anthropic — API key (fallback)

```bash
memphis provider add anthropic --api-key <key>
# writes: ANTHROPIC_VAULT_KEY=anthropic_api_key
```

### Minimax / DeepSeek / GLM

```bash
memphis provider add minimax  --api-key <key>
memphis provider add deepseek --api-key <key>
memphis provider add glm      --api-key <key>
```

Each writes `<PROVIDER>_VAULT_KEY=<provider>_api_key` into `.env` and stores
the value in the vault. Revoking a key: `memphis vault entry-delete --key
<name> --confirm` (or `--force` if `.env` still references it, which will
leave orphaned references you must clean up).

### Shared-LLM / Decentralized-LLM

```bash
memphis provider add shared-llm --api-key <key>
# writes: SHARED_LLM_API_KEY=VAULT:shared_llm_api_key

memphis provider add decentralized-llm --api-key <key>
# writes: DECENTRALIZED_LLM_API_KEY=VAULT:decentralized_llm_api_key
```

### Other tokens (HuggingFace, Google TTS, Telegram bot, …)

Generic `VAULT:<key>` prefix in `.env`:

```bash
memphis vault add --key telegram_bot_token --value <token>
# then in .env:
# MEMPHIS_TELEGRAM_BOT_TOKEN=VAULT:telegram_bot_token
```

## 5. Verify

```bash
memphis vault list    # metadata only — no plaintext ever leaves the vault
memphis doctor        # probes pepper strength, cipher cycle, provider wiring
```

If both `*_VAULT_KEY` and `*_API_KEY` are set for the same provider, Memphis
will warn at boot. With `MEMPHIS_STRICT_MODE=true`, it refuses to start
until you resolve the conflict. Remove the plaintext — the vault path is
the canonical one.

## 6. Never do this

- Never set both `*_API_KEY` and `*_VAULT_KEY` for the same provider in
  `.env`. Pick the vault path.
- Never rotate `MEMPHIS_VAULT_PEPPER` by editing `.env` directly. Use
  `memphis vault pepper-rotate --confirm` — it re-wraps the master key
  atomically and updates `.env` in a single step.
- Never paste keys into chat, commits, or PRs. If you already did, revoke
  them in the provider console before anything else.

## 7. Rotation

### Pepper rotation (periodic; quarterly is reasonable)

```bash
memphis vault pepper-rotate --confirm
```

Interactive. Prompts for the old pepper (or reads `MEMPHIS_VAULT_PEPPER`)
and a new one, re-wraps the master key under the new pepper, writes the
new pepper into `.env` atomically, and invalidates the in-memory cache.
Back up the new pepper off-host **before** you close the shell.

### Master-key rotation (after suspected key compromise)

```bash
memphis vault master-key-rotate --confirm
```

Generates a fresh random master key, re-encrypts every vault entry under
it, and swaps both `vault-state.json` and `vault-entries.json` atomically.
If any entry fails to decrypt under the current master key, the operation
aborts and names the offenders — delete them first with
`memphis vault entry-delete --key <name> --confirm`, then retry.

### Entry deletion

```bash
memphis vault entry-delete --key <name> --confirm
```

Refuses when `.env` still references the entry. Pass `--force` only if you
know the referenced provider will fail to load at runtime.

### Recovery

```bash
memphis vault recovery-unlock
```

Prompts for the recovery answer you set at init, resets the operator
passphrase, and authorizes the current session. Optionally run
`memphis vault pepper-rotate --confirm` afterwards to re-wrap under a new
pepper. Does not recover from a lost pepper alone.

## 8. Recovering from a dead vault (pepper drift)

If `memphis vault list` returns `vault_decrypt_failed`, the pepper in
`.env` no longer matches what `vault-state.json` was wrapped with. In
order of preference:

1. **Restore the correct pepper** from an off-host backup, re-run the read
   — the data is intact.
2. **Rotate to the current pepper** if you know the old one:
   ```bash
   memphis vault pepper-rotate --confirm
   # prompts for old pepper (even if env has the new one), then new pepper
   ```
3. **Last resort — destroy and re-init**:
   ```bash
   memphis vault reset --confirm   # moves vault-state/entries to data/vault-bak-<ts>/
   memphis vault init              # prompts for fresh passphrase + recovery Q/A
   # then re-add every provider key (you will need the raw secrets)
   ```

## 9. Audit trail

Every destructive op writes a `vault.*` event to
`data/security-audit.jsonl`. The log rotates at 5 MB into
`data/security-audit-archives/security-audit-<ISO>.jsonl.gz`. Search
across current + archived logs without un-gzipping:

```bash
memphis audit search                     # last 100 records, newest first
memphis audit search --action vault.     # every vault-related event
memphis audit search --since 2026-04-01T00:00:00Z --contains anthropic
memphis audit search --status error --limit 20
```

## 10. Quick reference

| I want to | Command |
| --- | --- |
| Seed a fresh host | `openssl rand -hex 32 → .env` → `memphis vault init` |
| Add a key | `memphis provider add <name> --api-key <k>` |
| Revoke a key | `memphis vault entry-delete --key <name> --confirm` |
| Rotate the pepper | `memphis vault pepper-rotate --confirm` |
| Rotate the master key | `memphis vault master-key-rotate --confirm` |
| Reset operator passphrase | `memphis vault recovery-unlock` |
| Verify everything | `memphis vault list && memphis doctor` |
| Review security events | `memphis audit search --action vault.` |
| Nuke and restart | `memphis vault reset --confirm` then `memphis vault init` |
