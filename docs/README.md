# Memphis Documentation

This index separates canonical docs from operational planning and historical material.

## Start Here

- [README](../README.md) - operator-first entrypoint
- [Getting Started](./GETTING-STARTED.md) - canonical local runtime path
- [Configuration](./CONFIGURATION.md) - runtime config and env reference
- [Troubleshooting](./TROUBLESHOOTING.md) - common runtime failures and fixes
- [API Reference](./API-REFERENCE.md) - current HTTP and gateway endpoints

## Canonical Product Docs

- [Canonical Architecture](./CANONICAL-ARCHITECTURE.md) - verified architecture source of truth
- [Runtime State Model](./RUNTIME-STATE-MODEL.md) - canonical runtime roots, cleanup semantics, and fresh-install contract
- [Runtime Security Architecture](./RUNTIME-SECURITY-ARCHITECTURE.md) - runtime dependency graph, trust boundaries, and security model
- [Execution Plan](./EXECUTION-PLAN.md) - canonical `v1.0.0` delivery record and post-GA baseline, including legacy sprint mapping
- [NAPI Contract](./NAPI-CONTRACT-V1.md) - Rust <-> TypeScript bridge contract

## Governance

Canonical product truth lives in this repository:

- `README.md`
- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/RUNTIME-STATE-MODEL.md`
- `docs/EXECUTION-PLAN.md`
- `docs/NAPI-CONTRACT-V1.md`
- runtime/public contract docs such as `docs/API-REFERENCE.md`, `docs/CONFIGURATION.md`, and `docs/RELEASE-PROCESS.md`

Repo-local `memory/` notes, overnight reports, and operator handoff snapshots are useful context,
but they are not canonical product truth unless explicitly linked from the list above.

Operational planning lives in the external workspace layer and is not canonical product truth:

- `../.openclaw/workspace/SPRINT_STATUS.md`
- `../.openclaw/workspace/SPRINT-PLAN-UPDATED.md`
- `../.openclaw/workspace/ROADMAP-COMPLETE.md`
- `../.openclaw/workspace/NEXT_CODER_TASKS.md`

Historical roadmap material remains for auditability:

- [ROADMAP-FULL-SPRINT3-TO-M8](./ROADMAP-FULL-SPRINT3-TO-M8.md) - historical roadmap, superseded and mapped into [Execution Plan](./EXECUTION-PLAN.md)
- [`../ROADMAP.md`](../ROADMAP.md) - repo-root historical roadmap pointer, superseded
- [`../ROADMAP-MASTER-QUEUE.md`](../ROADMAP-MASTER-QUEUE.md) - historical queue artifact, superseded
- [`../SPRINT_STATUS.md`](../SPRINT_STATUS.md) - repo-root historical sprint board pointer, superseded

## Operations and Release

- [Package Publish](./PACKAGE-PUBLISH.md)
- [Release Process](./RELEASE-PROCESS.md)
- [Operations Manual](./OPERATIONS-MANUAL.md)
- [Testing and Verification](./TESTING-VERIFICATION.md)

## Advisory / Downstream References

- [Hotel Deployment Reference](./HOTEL-DEPLOYMENT-REFERENCE.md) - optional hotel, Synjar, and PMS deployment patterns
- [Federation Key Exchange](./FEDERATION-KEY-EXCHANGE.md) - Matrix pilot and deferred public-federation hardening note
- [Soul Guide](./SOUL_GUIDE.md) - advisory reference for `soul-*` identity/memory surfaces; not the canonical product definition

## Legacy and Historical Material

Several docs in this directory remain for historical context, audits, or earlier design iterations.
Use the canonical documents above first. Treat older `v4` / `v5` strategy, release, architecture, and superseded roadmap docs as reference only.
