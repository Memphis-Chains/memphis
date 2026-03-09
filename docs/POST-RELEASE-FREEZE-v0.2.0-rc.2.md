# Post-release Freeze Note — v0.2.0-rc.2

Date: 2026-03-09
Baseline tag: `v0.2.0-rc.2`

## What shipped
- Local Ollama bridge managed by user systemd service.
- Healthcheck timer with auto-restart behavior.
- Unified runtime smoke command (`npm run smoke:ollama-runtime`).
- Nightly local runtime smoke + alert path.
- Runtime log retention maintenance script + policy.
- Operator runbooks/checklists for bridge runtime and recovery.
- Vault phase-1 runtime API path and deterministic runtime E2E.

## Known limits
- Cloud/shared provider path remains profile-dependent and may be unset.
- Runtime availability depends on local Ollama daemon health.
- Vault runtime path requires `MEMPHIS_VAULT_PEPPER` and bridge availability.
- Gateway `/ops/status` remains topology-dependent in current deployments.

## Freeze policy
- Baseline freeze is active on top of `v0.2.0-rc.2`.
- Allowed during freeze: additive hardening, ops safety, docs/runbook alignment, incident-driven fixes.
- Not allowed: broad architecture pivots or experimental refactors outside approved roadmap.

## Rollback
- Primary rollback anchor: `v0.2.0-rc.2`.
- Immediate runtime fallback: set `DEFAULT_PROVIDER=local-fallback` and restart app.
- Bridge recovery: `systemctl --user restart ollama-compat-bridge.service`.
- Code rollback: revert thematic commit groups from post-rc hardening PRs.
