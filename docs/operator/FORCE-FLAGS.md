# Force flags

Memphis treats certain destructive paths as fail-closed by default:
re-initializing a non-empty vault would orphan every encrypted entry,
and exiting without a supervisor leaves the agent dead in unsupervised
shells. Two env flags exist to override these guards. They are
**operator-deliberate, not operator-curiosity** — set them only when
you understand which guard you are bypassing and why.

| Flag | Default | Tier (mutability) | Override |
|------|---------|-------------------|----------|
| `MEMPHIS_VAULT_FORCE_REINIT` | `false` | reload | Vault re-init guard |
| `MEMPHIS_RESTART_ALLOW_SUICIDE` | `false` | warm | Self-restart no-supervisor guard |

## `MEMPHIS_VAULT_FORCE_REINIT`

### What it overrides

`memphis vault init` refuses every time `vault-state.json` is present
and contains a salt + master key. The refusal exists because re-init
generates a new master key, and old encrypted entries are unreadable
under the new key — the vault would silently lose every secret without
the guard.

The guard fires from two paths:

- `src/infra/storage/rust-vault-adapter.ts:553` — `refuseIfVaultStateExists`
  reads `vault-state.json` directly, throws `VaultAlreadyInitializedError`
  if both `salt` and an encrypted master key field exist.
- `src/security/vault-boundary.ts:202` — `initializeVault` lists existing
  entries and refuses if any are present.

### When to set it

Three legitimate cases:

1. **Disposable test box** — the vault holds nothing irreversible, and
   you want a fresh DID and master key for a clean smoke run.
2. **Confirmed wipe** — you have an external backup of every secret you
   need (passwords, API keys, signing material) and have decided the
   current vault is unrecoverable. Re-init wipes by design.
3. **Recovery from corrupt state** — `vault-state.json` exists but
   parses, and `memphis vault list` returns nothing useful. After
   manual triage of the file, you commit to discarding the state.

### How to set it

```bash
# One-shot
MEMPHIS_VAULT_FORCE_REINIT=1 memphis vault init

# Persistent (writes to ~/.memphis/.env via canonical setter)
echo 'MEMPHIS_VAULT_FORCE_REINIT=true' >> ~/.memphis/.env
```

Both `1`, `true`, `yes`, `on` parse as truthy via `parseBool` in
`src/core/env.ts`. Set to anything falsy or unset to re-arm the guard.

### What it doesn't do

- Does **not** decrypt the existing vault. Only bypasses the refusal.
  Whatever was in `vault-entries.json` becomes garbage under the new
  master key.
- Does **not** export the existing entries. Run `memphis vault export`
  first if you might want them later.
- Does **not** persist after the operation — set it once, vault is
  re-initialized once, the next normal `memphis vault init` is again
  refused.

### Audit trail

`writeVaultAudit(ctx, 'vault-init', 'blocked', ...)` records every
refusal with `reason: 'vault_reinit_blocked'`. Allowed re-inits get
`'vault-init', 'allowed', { did, ... }`. Both end up in
`data/security-audit.jsonl`.

## `MEMPHIS_RESTART_ALLOW_SUICIDE`

### What it overrides

The self-restart engine refuses to call `process.exit(0)` when no
process supervisor is detected. Detection looks for systemd
(`NOTIFY_SOCKET`, `INVOCATION_ID`, or a `memphis.service` unit file),
PM2 (`pm_id`/`PM2_HOME`), or the Memphis bootstrap unit.

Without a supervisor, exit leaves the agent dead — the process won't
come back until you manually relaunch.

The guard fires from `src/infra/runtime/self-restart.ts:191`. Setting
this flag bypasses it.

### When to set it

- **Local dev** — `npm run dev` or direct `node …` runs without a
  supervisor by design. Setting the flag lets you exercise the drain +
  audit + PULSE flow end-to-end.
- **Manual operator drill** — testing what happens after `process.exit`
  in a controlled environment where you intend to relaunch by hand.

### How to set it

```bash
# Persistent in dev shell
export MEMPHIS_RESTART_ALLOW_SUICIDE=true

# Or in ~/.memphis/.env for a dev box
echo 'MEMPHIS_RESTART_ALLOW_SUICIDE=true' >> ~/.memphis/.env
```

### What it doesn't do

- Does **not** spawn a replacement process. After exit, you relaunch.
- Does **not** skip the drain — in-flight turn aborts still happen.
- Does **not** affect any other restart mechanic. PULSE, audit, drain
  timeout all behave identically.

For full self-restart context, see [self-restart.md](./self-restart.md).

## Why these are env flags, not CLI flags

Both guards exist because the destructive case is **rare and
deliberate**. A CLI flag like `memphis vault init --force` is too easy
to typo into a recovery script, and `--allow-suicide` reads as a UX
ceremony rather than a real safety bypass. Env flags require the
operator to type the variable name in shell — the friction is the
feature.

## Related

- [Self-restart](./self-restart.md) — full restart engine documentation
- [Vault encryption guard](./CLEAN-INSTALL.md) — fresh-install vault flow
- [Disaster recovery](./disaster-recovery.md) — when re-init is the
  wrong tool and you should restore from backup instead
