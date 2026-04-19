# 04 — Vault setup: API keys, listing, recovery

> Continues from `03-first-chat.md`. Vault is the AES-256-GCM-encrypted
> store for all secrets. Nothing should live in `.env` if it can live in
> the vault.

## Add an API key

```
$ memphis vault add ANTHROPIC_API_KEY

Vault passphrase:
> ********************
Value for ANTHROPIC_API_KEY:
> ************************************************************
Confirm value:
> ************************************************************
[memphis-vault] Stored ANTHROPIC_API_KEY (encrypted with AES-256-GCM)
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
$ memphis vault get ANTHROPIC_API_KEY

Vault passphrase:
> ********************
sk-ant-***************************************************
```

(Yes, it's shown on stdout — sanitize when sharing terminal output.)

## Add several at once

```
$ for key in OPENAI_API_KEY GROQ_API_KEY MEMPHIS_TELEGRAM_BOT_TOKEN; do
    memphis vault add $key
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

```
$ memphis vault rotate

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
backup automatically (rust-vault-adapter.ts:739-743).

## Recovery flow (forgot vault passphrase)

```
$ memphis vault recover

[memphis-vault] Recovery question: What was the name of my first dog?
Recovery answer:
> ******
[memphis-vault] Answer matched.
New vault passphrase:
> ********************
Confirm new vault passphrase:
> ********************
[memphis-vault] Vault re-keyed with new passphrase.
[memphis-vault] All entries preserved.
```

The recovery answer is hashed (Argon2id) and combined with the master
key via HKDF — exactly the same primitive as initial KDF, just with the
recovery answer instead of the passphrase. There is no "backdoor" — if
you lose **both** passphrase and recovery answer, the vault is
unrecoverable by design.

## State after vault setup

```
$ ls ~/.memphis/vault/
-rw------- 1 operator operator  812 Apr 19 10:36 vault-entries.json
-rw------- 1 operator operator  324 Apr 19 10:36 vault-state.json

$ file ~/.memphis/vault/vault-entries.json
ASCII text  (header is JSON; payloads are base64-encoded ciphertext)

$ memphis vault verify
[memphis-vault] All 4 entries decrypt + checksum ok.
```

Now run [`memphis health --json`](./05-health-snapshot.json) to capture
the full healthy-state snapshot, and check
[`06-timing-baseline.txt`](./06-timing-baseline.txt) to compare against
the reference timing.
