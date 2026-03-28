# Guide: First Bootstrap Configuration

This guide documents the repaired first-run contract for Memphis `v1.x`.

## Canonical sequence

```bash
npm run bootstrap
memphis init
memphis health --json
memphis tui
```

## What each step owns

### `npm run bootstrap`

Technical install/build only:

- ensures `.env` exists
- generates `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER`
- ensures the agent profile exists
- builds TS + Rust
- prepares service wiring and workspace context

It does **not** silently create meaningful soul or identity state.

### `memphis init`

Controlled operator-first first-run:

- operator passphrase enrollment
- vault initialization
- first-state mode choice
- preview and confirmation of first chain writes
- first-run record creation

### `memphis health --json`

Confirms:

- first-run state
- repair state
- chain memory readiness
- derived cognition readiness

### `memphis tui`

Starts the native operator console after the controlled init is complete.

## Legacy note

`memphis configure` and `memphis onboarding wizard|bootstrap` are no longer the
canonical first-run path. Keep them only for legacy/internal compatibility.

## Related docs

- [GETTING-STARTED.md](./GETTING-STARTED.md)
- [INSTALLATION.md](./INSTALLATION.md)
- [CONFIGURATION.md](./CONFIGURATION.md)
- [RUNTIME-STATE-MODEL.md](./RUNTIME-STATE-MODEL.md)
