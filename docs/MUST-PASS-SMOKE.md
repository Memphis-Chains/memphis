# Must-pass Smoke Gate

Before merge to `main` in the post-GA patch lane:

## Mandatory shared release gate

1. `bash ./scripts/run-release-gates.sh`

This is the canonical shared release gate wrapper. It already includes:

- `npm run release:smoke`
- `npm run -s ops:release-preflight -- --json`
- lint
- typecheck
- `npm run ops:ga-smoke`
- `bash ./scripts/install.sh --check-only --json`
- `npm run ops:rc-drill:fresh-env`
- bounded Matrix pilot setup truth
- secret scan

## Canonical GA convergence smoke

2. `npm run ops:ga-smoke`

Use this standalone when you need the cross-surface acceptance pack without the full package/release checks.

## Extended runtime gate

3. `npm run ops:quality-runtime-pack`
4. `npm run smoke:ollama-runtime` only when the Ollama bridge lane is part of the target runtime profile

Notes:

- `ops:quality-runtime-pack` always enforces core local-runtime gates.
- It may skip the Ollama bridge smoke when the bridge is not running locally.
- Set `REQUIRE_OLLAMA_BRIDGE_SMOKE=1` to fail closed and require that lane explicitly.

## Mandatory when vault path is in scope

5. `MEMPHIS_VAULT_PEPPER='<12+ chars>' ./scripts/vault-runtime-e2e.sh`
6. `MEMPHIS_VAULT_PEPPER='<12+ chars>' npm run drill:vault-recovery`

## Recovery discipline

- `npm run drill:bridge-recovery` must pass at least once per release cycle.
- Keep drill output artifact under `docs/RECOVERY-DRILLS-*.md`.

A PR is not merge-ready if any mandatory smoke/drill fails.
