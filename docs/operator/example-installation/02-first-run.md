# 02 — First run: `memphis init`

> ⚠️ **SYNTHETIC EXAMPLE** — interactive prompts and output below are
> illustrative reconstructions, not captured from a real `memphis init`
> run. Order and meaning of prompts is correct; exact wording and DID
> format will differ. Verify against your actual run.

> Continues from `01-fresh-install.md`. After this, Memphis has identity,
> vault, and the canonical chains (8 logical chains in v1.4.0+ after the
> chain-catalog reconciliation fix). State lives in `~/.memphis/`.

## Run init

```
$ memphis init

[memphis] First-run setup
[memphis] Will create:
  - operator config: /home/operator/.config/memphis/operator.json
  - vault state:     /home/operator/.memphis/vault/
  - chains root:     /home/operator/.memphis/chains/
  - data dir:        /home/operator/.memphis/data/

Operator passphrase (used to elevate to tier 2 — write/execute tools):
> ********************
Confirm operator passphrase:
> ********************
[memphis] Operator passphrase set (Argon2id, 64 MiB / 3 iter / p=4)

Vault passphrase (encrypts your secrets vault — different from operator passphrase):
> ********************
Confirm vault passphrase:
> ********************
[memphis] Vault passphrase set

Recovery question (used if you ever lose the vault passphrase):
> What was the name of my first dog?
Recovery answer:
> ********
Confirm recovery answer:
> ********
[memphis] Recovery question + answer hashed

Agent name (for chain entries) [Memphis Agent]: Marcin's Memphis
Owner name [operator]: marcin

[memphis] Generating DID (ed25519)...
[memphis] DID: did:mph:ABCdef1234567890... (truncated)
[memphis] Public key written to /home/operator/.memphis/identity.pub

[memphis] Initializing canonical chains:
  - journal       (operator memories)
  - decisions     (operator decisions)
  - reflections   (self-reflection passes)
  - patterns      (pattern recognition)
  - cases         (case-based reasoning)
  - system        (system events + boot log)
  - proactive     (proactive suggestions)

[memphis] Genesis blocks written.
[memphis] First-run complete.

Next steps:
  memphis doctor              # verify everything is healthy
  memphis service install     # install systemd user service
  memphis service start       # start the runtime daemon

real    0m18s
```

## Verify state

```
$ memphis doctor

[memphis-doctor] Pre-flight check
✓ operator.json present and readable
✓ operator passphrase Argon2id parameters: 64 MiB / 3 iter / p=4
✓ vault initialized
✓ vault file mode 0o600 (private)
✓ vault directory mode 0o700 (private)
✓ DID present and signature-verifiable
✓ all 7 canonical chains present with genesis blocks
✓ chain block signatures verifiable
✓ memphis-napi bridge loaded
✓ memphis-vault crate version matches package.json
✓ build artifacts present

[memphis-doctor] All checks passed.

real    0m3s
```

## Install systemd service

```
$ memphis service install

[memphis-service] Writing /home/operator/.config/systemd/user/memphis.service
[memphis-service] Reloading systemd user daemon
[memphis-service] Service installed (not started). Use:
  memphis service start

$ memphis service start
[memphis-service] Starting memphis.service via systemctl --user
[memphis-service] Service started. PID: 12345

$ memphis service status
● memphis.service - Memphis sovereign cognitive runtime
     Loaded: loaded (/home/operator/.config/systemd/user/memphis.service)
     Active: active (running)
       Logs: journalctl --user -u memphis -f
```

## State after first-run

```
$ ls -la ~/.memphis/
drwx------  6 operator operator   180 Apr 19 10:30 .
drwxr-xr-x 14 operator operator   280 Apr 19 10:30 ..
drwx------  9 operator operator   220 Apr 19 10:30 chains
drwx------  3 operator operator    80 Apr 19 10:30 data
-r--------  1 operator operator    96 Apr 19 10:30 identity.pub
drwx------  2 operator operator    60 Apr 19 10:30 logs
drwx------  3 operator operator    80 Apr 19 10:30 state
drwx------  3 operator operator    80 Apr 19 10:30 vault

$ ls ~/.memphis/chains/
journal/  decisions/  reflections/  patterns/  cases/  system/  proactive/

$ ls ~/.memphis/chains/journal/
000000.json    ← genesis block
```

Continue to [`03-first-chat.md`](./03-first-chat.md).
