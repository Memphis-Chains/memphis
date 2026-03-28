# Onboarding / Install Path

This document only describes the active first-run story for Memphis `v1.x`.

## Canonical path

```bash
npm run bootstrap
memphis init
memphis health --json
memphis tui
```

What each step means:

- `bootstrap` is technical install/build only
- `init` is the canonical operator-first onboarding flow
- `health` confirms first-run state, repair state, and memory readiness
- `tui` is the native operator console after initialization

## What `memphis init` owns

- operator passphrase enrollment,
- vault initialization,
- first-state mode selection,
- preview/confirmation of initial chain writes,
- final health summary.

Memphis no longer treats `configure` or `onboarding wizard` as primary onboarding.

## Optional paths

- `memphis setup matrix --json` is an optional Matrix trusted-pilot bootstrap
- `memphis repair runtime` repairs degraded derived state

## Legacy/internal paths

The following commands still exist only for compatibility or internal ops and are
not part of the supported first-run contract:

- `memphis configure`
- `memphis onboarding wizard`
- `memphis onboarding bootstrap`

## Verification

```bash
memphis doctor --fix
memphis health --json
memphis ask --input "Onboarding verification" --provider local-fallback
```

If you need full install detail, use [GETTING-STARTED.md](./GETTING-STARTED.md)
and [INSTALLATION.md](./INSTALLATION.md).
