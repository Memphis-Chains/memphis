# Memphis — Codebase Truth Delta — 2026-05-08

**Supersedes** §5 of `docs/dev/CODEBASE-TRUTH-2026-04-27.md` (handler/auth-gating matrix).
**Adds** new sections — limits and tier-3 surface — that did not exist in the 04-27 snapshot. Those are shipped as separate docs:
- `docs/dev/LIMITS-MATRIX-2026-05-08.md`
- `docs/dev/TIER3-SURFACE-AUDIT-2026-05-08.md`

This doc lists ONLY the changes to the 04-27 truth-snapshot. §1, §2, §3, §4, §6, §7, §8 of the 04-27 snapshot are unchanged or out of scope here.

---

## Δ §5 — Dispatcher / handler / auth-gating matrix (UPDATED)

### Counts (vs 04-27)

| Metric | 04-27 | 05-08 |
|---|---|---|
| Total CLI handlers (`*.handler.ts`) | 31 | **34** (+3: `brave`, `identity`, `voice`, `export`; `chat` removed → not present) |
| Total CLI commands (`commands/*.ts`) | (not counted) | 26 |
| Handlers calling `requireOperatorAuth()` | **1** (`vault`) | **4** (`vault`, `secret`, `trust`, `evolve`) |
| Commands calling `requireOperatorAuth()` | (not counted) | **3** (`backup`, `service`, `restart`) |
| Total modules gating | 1 / 31 (3.2%) | **7 / 60 (12%)** |

**Improvement since 04-27**: 6 new gating call-sites added across `secret`, `trust`, `evolve`, `backup`, `service`, `restart`. The S5-1 sweep referenced in `auth.handler.ts:229` partially executed.

### Full callsite list — `requireOperatorAuth`

```
src/infra/cli/handlers/secret.handler.ts:26      — secret (top-level)
src/infra/cli/handlers/secret.handler.ts:45      — secret (subcommand absent path)
src/infra/cli/handlers/trust.handler.ts:47       — trust add
src/infra/cli/handlers/trust.handler.ts:93       — trust remove
src/infra/cli/handlers/trust.handler.ts:129      — trust audit
src/infra/cli/handlers/vault.handler.ts:179      — vault add
src/infra/cli/handlers/vault.handler.ts:295      — vault get
src/infra/cli/handlers/vault.handler.ts:360      — vault entry-delete
src/infra/cli/handlers/vault.handler.ts:375      — vault list
src/infra/cli/handlers/vault.handler.ts:391      — vault rotate
src/infra/cli/handlers/vault.handler.ts:471      — vault recovery-unlock
src/infra/cli/handlers/vault.handler.ts:687      — vault master-key-rotate
src/infra/cli/handlers/vault.handler.ts:914      — vault pepper-rotate
src/infra/cli/handlers/evolve.handler.ts:75      — evolve self-modify
src/infra/cli/commands/backup.ts:996             — backup create
src/infra/cli/commands/backup.ts:1016            — backup restore
src/infra/cli/commands/service.ts:195            — service install/uninstall
src/infra/cli/commands/restart.ts:44             — service restart
```

**17 enforcement call-sites** (was 8 in 04-27 per vault alone).

### Critical asymmetries — issue #278 P1 still open

5 handlers with destructive ops remain UNGATED:

| Handler | Destructive ops |
|---|---|
| `provider.handler.ts` | writes API keys via `storeVaultSecret` |
| `worker.handler.ts` | job mutation, queue ops |
| `telegram.handler.ts` | bot token, allowed-users mutation |
| `consent.handler.ts` | consent record mutation |
| `schedule.handler.ts` | scheduled task add/remove |

These are the **Phase 4.3 work-list** to close issue #278.

### Asymmetric gating note (vault unchanged)

`vault.handler.ts` continues to over-gate — `vault list` and `vault get` (read ops) require operator auth too. This is intentional under the threat model (vault listing leaks secret names → reduces blast radius for local-host adversary). Documented here, not changed.

### Lifecycle / passphrase forms supported

All gating sites support 3 input modes (per `requireOperatorAuth(undefined, env, args.operatorPassphrase)` signature):
1. Interactive TTY prompt (default)
2. `--operator-passphrase <pw>` CLI flag (per-command, e.g. `restart.ts:44`)
3. `MEMPHIS_OPERATOR_PASSPHRASE` env var (non-interactive flows)

This is the **escape hatch** Phase 4.3 PRs must preserve when gating the remaining 5 handlers.

---

## Δ §6 — Error-message inconsistency catalog (no change since 04-27)

The 6 sites listed in the 04-27 doc remain unchanged. No regression, no new gold-standard sites.

---

## Notes for downstream phases

- **Phase 1.1 (telegram MarkdownV2)** does not touch gating — Telegram channel message-send is non-CLI, no auth gate needed.
- **Phase 1.3 (process-lock)** affects `restart.ts` (already gated) — no new gate needed; `memphis stop --force` reuses existing `restart`-style auth.
- **Phase 4.3** closes #278 by gating the 5 listed handlers. Total post-Phase-4.3 enforcement: **12 / 60 (20%)**, up from 7 / 60 today and 1 / 31 in 04-27.
- **Phase 4.2** adds tier-3 reporting to `doctor-v2` and `/v1/ops/status` — see `TIER3-SURFACE-AUDIT-2026-05-08.md` for the spec.

---

**Generated**: 2026-05-08 by autopilot Phase 0.5 (`automode-silly-pike`).
**Method**: `grep -rn "requireOperatorAuth" src/` filtered for non-test, non-comment, non-export call-sites; `ls src/infra/cli/handlers/*.handler.ts` for handler count.
