# Must-pass Smoke Gate

Before merge to `main` for production-track hardening:

## Mandatory
1. `npm run ops:quality-runtime-pack`
2. `npm run smoke:ollama-runtime`

## Mandatory when vault path is in scope
3. `MEMPHIS_VAULT_PEPPER='<12+ chars>' ./scripts/vault-runtime-e2e.sh`
4. `MEMPHIS_VAULT_PEPPER='<12+ chars>' npm run drill:vault-recovery`

## Recovery discipline
- `npm run drill:bridge-recovery` must pass at least once per release cycle.
- Keep drill output artifact under `docs/RECOVERY-DRILLS-*.md`.

A PR is not merge-ready if any mandatory smoke/drill fails.
