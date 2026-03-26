# Must-pass Smoke Gate

Before merge to `main` for production-track hardening:

## Mandatory release gate

1. `npm run release:smoke`

This is the canonical release gate. It already includes:

- lint
- typecheck
- `npm run ops:ga-smoke`
- package dry-run
- secret scan

## Canonical GA convergence smoke

2. `npm run ops:ga-smoke`

Use this standalone when you need the cross-surface acceptance pack without the full package/release checks.

## Extended runtime gate

3. `npm run ops:quality-runtime-pack`
4. `npm run smoke:ollama-runtime`

## Mandatory when vault path is in scope

5. `MEMPHIS_VAULT_PEPPER='<12+ chars>' ./scripts/vault-runtime-e2e.sh`
6. `MEMPHIS_VAULT_PEPPER='<12+ chars>' npm run drill:vault-recovery`

## Recovery discipline

- `npm run drill:bridge-recovery` must pass at least once per release cycle.
- Keep drill output artifact under `docs/RECOVERY-DRILLS-*.md`.

A PR is not merge-ready if any mandatory smoke/drill fails.
