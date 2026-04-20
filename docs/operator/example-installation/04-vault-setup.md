# 04 — Vault setup: API keys, listing, rotation, recovery

> ⚠️ **SYNTHETIC EXAMPLE** — vault command outputs below are illustrative
> reconstructions. **All command syntax is now verified against
> `src/infra/cli/handlers/vault.handler.ts` v1.4.0 dispatcher** (Codex
> P1 fixes 2026-04-19). Real subcommands per registry:
> `init|add|get|list|reset|pepper-rotate|master-key-rotate|entry-delete|recovery-unlock`.

> Continues from `03-first-chat.md`. Vault is the AES-256-GCM-encrypted
> store for all secrets. Nothing should live in `.env` if it can live in
> the vault.

## Add an API key

The handler requires `--key <name>` (positional name is rejected):

```
$ memphis vault add --key ANTHROPIC_API_KEY

Vault passphrase:
> ********************
Value for ANTHROPIC_API_KEY:
> ************************************************************
Confirm value:
> ************************************************************
[memphis-vault] Stored ANTHROPIC_API_KEY (encrypted with AES-256-GCM)
```

Or pass the value inline (non-interactive scripting):

```
$ memphis vault add --key ANTHROPIC_API_KEY --value "$ANTHROPIC_API_KEY" --passphrase "$VAULT_PASSPHRASE" --json
```

## List vault entries (metadata only)

```
$ memphis vault list

Vault passphrase:
> ********************
[memphis-vault] 1 entry:
  ANTHROPIC_API_KEY  (added: 2026-04-19T10:35:12Z, 64 bytes encrypted)
```

The **value is never displayed** by `vault list` — that would defeat the
encryption. To see a value:

```
$ memphis vault get --key ANTHROPIC_API_KEY

Vault passphrase:
> ********************
sk-ant-***************************************************
```

(Yes, it's shown on stdout — sanitize when sharing terminal output.)

## Add several at once

```
$ for key in OPENAI_API_KEY GROQ_API_KEY MEMPHIS_TELEGRAM_BOT_TOKEN; do
    memphis vault add --key $key
  done

(prompts for vault passphrase + each value, individually)
```

## Use the vault from chat

```
$ memphis chat --input "Hello" --provider anthropic

[memphis] provider: anthropic
[memphis] resolving ANTHROPIC_API_KEY from vault... ok
[memphis] tokens in: 1  out: 12  duration: 1.2s

Hello! How can I help you today?
```

The vault passphrase prompt happens once per session (TTL 15 min). After
that, the runtime can resolve vault keys without re-prompting.

## Rotate the master key

The real subcommand is `master-key-rotate` (not `rotate`):

```
$ memphis vault master-key-rotate

Current vault passphrase:
> ********************
New vault passphrase:
> ********************
Confirm new vault passphrase:
> ********************

[memphis-vault] Rotating master key...
[memphis-vault] Re-encrypting 4 entries with new key...
[memphis-vault] Writing tmp files + fsync (PR #146 fix)...
[memphis-vault] Atomic rename tmp → live...
[memphis-vault] Rotation complete. Old master key zeroed.
```

If anything fails mid-rotation, the catch block restores the pre-rotation
backup automatically (`src/infra/storage/rust-vault-adapter.ts:739-743`).

To rotate just the per-entry pepper (lighter operation, master key
unchanged):

```
$ memphis vault pepper-rotate
```

## Recovery flow (forgot vault passphrase)

The real subcommand is `recovery-unlock` (not `recover`). **Important
caveat:** the implemented recovery path resets the **operator
passphrase** and explicitly does NOT recover a lost vault pepper. If
your vault pepper is lost, the entries cannot be decrypted — recovery
restores access to the operator role but does not magically re-derive
the per-entry encryption keys.

```
$ memphis vault recovery-unlock

Recovery question: <prompted from your vault-state.json>
Recovery answer:
> ******
[memphis-vault] Answer matched.
New operator passphrase:
> ********************
Confirm new operator passphrase:
> ********************
[memphis-vault] Operator passphrase reset.
[memphis-vault] WARNING: this flow restores OPERATOR role access; it does
[memphis-vault] not recover a lost vault pepper. If pepper is lost, vault
[memphis-vault] entries remain unrecoverable by design.
```

The recovery answer is hashed (Argon2id) and combined with the master
key via HKDF — exactly the same primitive as initial KDF, just with the
recovery answer instead of the passphrase. There is no "backdoor" — if
you lose **both** passphrase, recovery answer, AND pepper, the vault is
unrecoverable by design.

## State after vault setup

Default vault file paths (from `.env.example` + `src/infra/storage/rust-vault-adapter.ts`):

```
$ ls ./data/vault*.json
-rw-------  812 Apr 19 10:36 ./data/vault-entries.json
-rw-------  324 Apr 19 10:36 ./data/vault-state.json
```

Or, if `MEMPHIS_VAULT_ENTRIES_PATH` / `MEMPHIS_VAULT_STATE_PATH` are set
to `~/.memphis/vault/`:

```
$ ls ~/.memphis/vault/
-rw-------  812 Apr 19 10:36 vault-entries.json
-rw-------  324 Apr 19 10:36 vault-state.json
```

```
$ file ./data/vault-entries.json
ASCII text  (header is JSON; payloads are base64-encoded ciphertext)
```

To verify entries decrypt correctly post-rotate, list them again with
the new passphrase (any successful `list` proves the new master key
works):

```
$ memphis vault list
Vault passphrase:
> ******************** (new passphrase)
[memphis-vault] 4 entries
```

> Note: there is **no** `memphis vault verify` subcommand. The valid
> verification path is `vault list` (proves decrypt) or `vault get
> --key <KEY>` (proves single-entry decrypt + checksum).

Now run [`memphis health --json`](./05-health-snapshot.json) to capture
the full healthy-state snapshot, and check
[`06-timing-baseline.txt`](./06-timing-baseline.txt) to compare against
the reference timing.
