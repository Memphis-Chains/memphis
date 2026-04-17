# ROADMAP for Sort Branches

> Source-of-truth roadmap mapping Memphis architectural vision → branch names → GitHub issues.
> Captured from planning session 2026-04-17 after PR #146 merged.
> Includes both the full ambitious vision AND the brutal-truth reality check.

## Navigation

- [Vision (full)](#vision-11-phase-plan)
- [Brutal truth](#brutal-truth--reality-check)
- [Two-horizon pragmatic recommendation](#two-horizon-pragmatic-recommendation)
- [Branch naming map](#branch-naming-map)
- [Function Evaluation Template](#function-evaluation-template)
- [Outstanding decisions](#outstanding-decisions)

---

## Context

Memphis = per-device sovereign AI runtime. Operator has full control of one
instance on one device. Hermetic (nothing leaves without explicit consent),
observable (every decision visible at creation + code + UX).

Current state on `main` post-PR #146:
- 33 security + reliability fixes merged (PR #127, #141, #146)
- Signed-block peer sync enforced (#142)
- Dashboard auth-token support (#143)
- Vault Result error propagation (#144)
- Vault rotation fsync (#145)
- 2054/2054 tests passing
- 0 npm audit (prod) advisories
- ASan clean on memphis-vault + memphis-core

Vision beyond this: Tauri GUI on Ubuntu + private-tier hermeticism complete +
public Agora marketplace (4-layer trust: DID + web-of-trust + stake + reputation).

All configuration goes through **Blueprint Config System** (Zod schema → GUI
form + TS validator + MCP tool schema + docs). Every financial decision uses
the existing vault-2FA (operator passphrase + recovery Q&A) gate.

## Locked decisions

| Decision | Choice |
| --- | --- |
| Repo layout | **Single `memphis` monorepo** (not split into 3 repos) |
| GUI framework | Tauri 2 |
| Target OS | Ubuntu (primary), any systemd+glibc Linux (secondary), WSL2 (compat) |
| GUI design language | Zed × VSCode × Tailscale hybrid |
| Install modes | Appliance (GUI-as-shell) / Desktop (normal + app) / Server (headless) |
| Agora trust model | All 4 layers composed |
| Payment rail | Free for demo/test → vault-secret wallets later via pluggable adapter |
| Slash multisig | Configurable 2-of-N, min 2, max 10 |
| Local-LLM fallback | Unconditional invariant, CI-enforced |
| Attestation TTL | Both persistent + expiring, configurable via Blueprint |
| Trust anchors | Dual chain: `trust.chain` (current) + `trusted.chain` (forensic audit) |
| Config surface | Blueprint system (Zod → codegen GUI + validator + MCP + docs) |
| memphis-ml role | Candidate Agora contract language (Phase 3 — conditional on market validation) |

## Architecture stack (final target)

```
┌─────────────────────────────────────────────────────────────────┐
│  apps/memphis-gui (Tauri)                                        │
│    Chat · Memory · Agents · Tools · Logs · Settings · Agora      │
├─────────────────────────────────────────────────────────────────┤
│  Blueprint Config System (Zod → GUI form + validator + MCP +    │
│  docs, single source of truth for every config knob)            │
├─────────────────────────────────────────────────────────────────┤
│  Memphis TS core (gateway, sync-manager, MCP tools, providers)  │
│    ↑ napi bridge ↓                                              │
│  Memphis Rust core (memphis-core, memphis-vault, memphis-napi)  │
├─────────────────────────────────────────────────────────────────┤
│  Chains:                                                         │
│    journal · soul · decisions · trust · trusted · agora.*       │
├─────────────────────────────────────────────────────────────────┤
│  Transport: sync-manager (signed-block push/pull)               │
│    — private tier (allowlisted peers, mutual auth)              │
│    — public tier (Agora DHT/gossip, ranked by L1+L2+L3)         │
├─────────────────────────────────────────────────────────────────┤
│  memphis-ml contract VM (Agora offers as ML programs, replayable │
│    deterministically by arbiters)                                │
└─────────────────────────────────────────────────────────────────┘
```

---

## Vision: 11-phase plan

| # | Phase | Branch name | Est. | Dep | Outcome |
| --- | --- | --- | --- | --- | --- |
| P | Private tier hardening | `feat/phase-P-private-tier` | 1 wk | — | mutual auth, revocation, rate limits, QR bootstrap |
| L | Local-LLM invariant test | `feat/phase-L-local-llm-invariant` | 0.5d | — | CI-enforced offline operability |
| B | Blueprint Config System | `feat/phase-B-blueprint-config` | 0.5–1 wk | — | DSL + codegen + pilot migration |
| T | Trust chains | `feat/phase-T-trust-chains` | 1 wk | P, B | `trust.chain` + `trusted.chain` dual-write, operator CLI |
| G | Tauri GUI skeleton | `feat/phase-G-gui-skeleton` | 2 wk | B | monorepo `apps/memphis-gui/`, Chat+Memory+Agents views |
| 0 | Agora design doc | `feat/phase-0-agora-design-doc` | 0.5 wk | T | locked schemas, thresholds, protocols |
| 1 | L1 Attestations | `feat/phase-1-attestations` | 1 wk | T, 0 | attestation blocks, trust-graph BFS |
| 2 | L3 Reviews | `feat/phase-2-reviews` | 0.5 wk | 1 | review blocks, weighted-PageRank reputation |
| 3 | L2 Stake + ML contracts | `feat/phase-3-stake-ml-contracts` | 2–3 wk | 1, 2 | escrow + ML-as-offer-language + payment adapter stub |
| 4 | L4 Discovery | `feat/phase-4-discovery` | 1 wk | 3 | DHT or gossip + ranked offer discovery |
| 5 | Marketplace UX | `feat/phase-5-marketplace-ux` | 1–2 wk | 3, 4, G | publish/sign/review flows in GUI |

**Full-plan total:** 8–12 weeks of focused solo work (optimistic).

Detailed function specifications in each GitHub issue — see issues #147–#158.

---

## Brutal truth — reality check

This section was explicitly requested (2026-04-17) after the full plan was
written, as a counterweight against solo-dev over-estimation. It reflects
honest risk assessment, not delivery pessimism.

### What's genuinely solid
1. **Core Memphis** (runtime, vault, chains, sync, MCP) — architectonicznie sound, production-feasible.
2. **Phases P + L + T** — realistic, each has clear acceptance criteria, each is a measurable security/reliability win.
3. **TDD PoC-first pattern** — established by PR #141 + #146, should be preserved.

### What's over-estimated or over-engineered

**Agora marketplace (Phases 3–5)** — underscoped by ~3–5×. A 4-layer trust
model + economic staking + reputation + discovery + arbitration + contract
language is a **separate product of equivalent size to Memphis itself**.
Industry references: Filecoin ($200M, 5 yrs, team of 20+), Bisq (6+ yrs, 10+
eng), even Nostr marketplace (2 yrs community effort). Realistic solo-dev
effort: **6–12 months focused work**, not 6 weeks.

**memphis-ml integration (Phase 3b)** — prerequisites alone are 4–6 weeks:
`ml-vm` crate currently broken, `ml-p2p` tightly coupled to raw-TCP, no
determinism-replay harness. And the fundamental question: does Agora even
need a DSL? JSON schema + endpoint URL may suffice for MVP.

**Blueprint Config System (Phase B)** — classic YAGNI at current scale. Memphis
has ~40 env vars but none paincal enough to demand a meta-framework. Build
the meta-system **after** you've manually written 5 settings forms and feel
the pain. Not before.

**Tauri GUI (Phase G)** — 3k LOC estimate is optimistic by 2–3×. Production
chat+streaming + memory browser + peers + tools + logs + settings + status
bar + palette + systray + packaging is realistically **8–15k LOC**. Plus
Tauri has its own learning curve (IPC allowlist, capability system).

**Appliance-as-default-shell** — technically fine but high support burden.
Every Ubuntu update can break it. Operator crash-debug at 3 AM is painful
without TTY fallback. Realistic demand: ~5% of users want appliance, 95%
want normal-desktop-plus-Memphis-app.

**Linux distribution surface (ISO + APPX + apt meta-packages)** — 2–3 months
of work on its own. Not a "Phase D bullet point".

### Solo-dev pace reality
- PR #141 + #146 shipped ~27 items in ~8–10h of focused work **with Claude
  writing 90% of the code**.
- True solo pace = 200–500 "good" lines/day, 1–2k/week.
- Full plan needs ~20–30k LOC in 8–12 wks = 2–3k/wk = realistic **upper bound**
  of solo velocity, assuming 100% focus, zero life interruptions, zero rework.

### Likely outcomes if plan runs as-is
- (a) Burnout at week 8, Memphis frozen half-built
- (b) Everything at 60% complete, nothing production-ready
- (c) Refactor paralysis ("need Blueprint before Settings before GUI before ship")

---

## Two-horizon pragmatic recommendation

Instead of executing the full 11-phase plan linearly, split into two horizons
with a hard decision gate between them.

### Horizon 1 — 2–3 weeks, measurable wins

Sprint goals:
1. **Phase P** (3–4 d) — private tier hardening (mutual auth, revocation, rate limits, QR bootstrap)
2. **Phase L** (½ d) — local-LLM invariant CI test
3. **Phase T** (2–3 d) — trust chains dual-write + operator CLI commands

**Ship `v1.4.0`.** Write down what you learned.

**Skip (for now):**
- Phase B (Blueprint) — defer until pain is acute
- Phase 0 (Agora design) — defer until H2 passes
- All Phases 1–5 (Agora) — defer

### Horizon 2 — 3–4 weeks, GUI minimal viable

4. **Phase G-minimal** (3 wk) — Tauri + React + shadcn/ui, **only** chat view + status bar + hand-written settings form. **Explicitly NOT**: memory browser / peers / tools / logs / palette. Monorepo `apps/memphis-gui/`.
5. **Ship `v1.5.0` as "Memphis Desktop Preview"**. Give it to 5–10 users for a month.
6. **Listen to feedback.**

### Decision gate

After ~6 weeks of H1 + H2:
- Does anyone use Memphis on desktop?
- What actually hurts them?
- Did anyone ask for a marketplace?
- Is 2-peer federation stable in practice?

**Only then** decide on Agora. If yes, start with **Phase 1 (attestation-only)**,
zero stake, zero payment, zero DHT. Validate that web-of-trust works socially
before investing in economic layer.

### Rzeczy do odłożenia (for now)

| Defer | Reason |
| --- | --- |
| Blueprint Config System | Build when it hurts (5+ manual copy-paste of form boilerplate) |
| memphis-ml integration | Defer until Agora demand proven |
| DHT/gossip discovery | Start with explicit peer-list if Agora ships |
| Payment adapter | Symbolic numbers on chain suffice for MVP |
| Appliance-as-default-shell | Keep as opt-in, NOT default |
| WSL2 custom distro APPX | `wsl --install Ubuntu` + `apt install memphis` sufficient |
| Live ISO | `.deb` on Ubuntu is enough as first distribution |
| ML-as-contract-language | JSON schema offers suffice for MVP |

---

## Branch naming map

Branches follow the convention established by PR #141 + #146:

```
feat/phase-<letter>-<short-name>       # planned feature work
hotfix/<description>                   # security or reliability fix
hotfix/codex-round-N                   # bundled hotfix per Codex review round
hotfix/security-scan-<date>            # bundled security-scan hotfix
```

### Phase → branch map (as issues get worked)

| Issue | Branch | Status |
| --- | --- | --- |
| Meta roadmap | N/A (tracking only) | open |
| Phase P | `feat/phase-P-private-tier` | pending |
| Phase L | `feat/phase-L-local-llm-invariant` | pending |
| Phase B | `feat/phase-B-blueprint-config` | **deferred** (see brutal truth) |
| Phase T | `feat/phase-T-trust-chains` | pending |
| Phase G | `feat/phase-G-gui-skeleton` | pending (after H1 passes) |
| Phase 0 | `feat/phase-0-agora-design-doc` | **deferred** (after H2 validation) |
| Phase 1 | `feat/phase-1-attestations` | deferred |
| Phase 2 | `feat/phase-2-reviews` | deferred |
| Phase 3 | `feat/phase-3-stake-ml-contracts` | deferred (2027 candidate) |
| Phase 4 | `feat/phase-4-discovery` | deferred |
| Phase 5 | `feat/phase-5-marketplace-ux` | deferred |

---

## Function Evaluation Template

Every function introduced under this roadmap gets the following specification
in JSDoc / rustdoc and in the PR body:

```
### fn <name>(<args>) -> <return>

Contract
  inputs: <types + ranges + value constraints>
  returns: <success shape>
  throws: <named error kinds + when-to-throw>

Invariants
  I1. <what MUST always hold>
  I2. ...

Failure modes
  F1. <how each error kind is reached + user-visible message>

PoC test
  tests/<path>.test.ts — failing on current code, green on the fix.
  asserts: <exact boolean>

Integration test
  tests/integration/<path>.test.ts — composes with <other functions>.
  asserts: <end-to-end observable>

Observable success signal
  CLI / TUI / GUI surface: <what operator sees>
  Chain / log entry: <which chain, block type, field>

Performance budget (where relevant)
  p50 ≤ <ms>, p99 ≤ <ms>, memory ≤ <MB>
```

**Definition of done** for any PR shipping new functions: all 7 sections filled.

---

## Cross-cutting concerns

### Blueprint usage policy (post-Phase B)
Every new config option MUST be added as a Blueprint. No new `MEMPHIS_*` env
var merges without an accompanying Blueprint.

### Local-LLM invariant enforcement (post-Phase L)
The `offline-invariant.test.ts` gate is non-negotiable. Any PR that makes
Memphis require a remote call for a core operation (chat, chain, vault, tool)
is rejected.

### Chain audit discipline
Every operator-initiated state change → chain block. Every finance decision →
vault-2FA modal → chain block. No silent state mutations.

### memphis-ml preconditions (before Phase 3b)
- Fix or remove `ml-vm` from workspace (currently broken)
- Replace `ml-p2p` raw-TCP transport with memphis sync-manager adapter
- Add determinism-tracing hooks so arbiters can replay (core interpreter IS
  deterministic; I/O is not — journal captures I/O, replay from journal)

---

## Outstanding decisions

Blockers still needing user input before specific phases begin:

| Decision | Blocks | Default if unspecified |
| --- | --- | --- |
| Tauri frontend stack (React+shadcn / Svelte / Leptos) | Phase G start | **React+shadcn/ui** |
| System tray in Desktop install mode | Phase G packaging | **Yes, systemd --user + tray** |
| memphis-ml ml-vm handling | Phase 3b prereq | **Remove from workspace** |
| Blueprint codegen timing (build-time vs runtime) | Phase B start | **Hybrid** (types build-time, form runtime) |
| Agora DHT choice (libp2p vs Nostr vs custom) | Phase 0 outcome | **libp2p Kademlia** (most mature) |
| Distribution forms (.deb / ISO / Docker / APPX) | Phase D | **.deb first, rest deferred** |
| Appliance mode as default install | Phase D | **Opt-in, not default** |

---

## Sprint 1 concrete deliverables (per Horizon 1)

All three tracks can run in parallel:

**Track 1 — Phase L (½ day):**
- `tests/integration/offline-invariant.test.ts`
- Add step to `.github/workflows/ci.yml`
- Ships as 1 PR, ~150 LOC

**Track 2 — Phase P (3–4 days):**
- `src/sync/peer-auth.ts` → `enforcePeerTransportAuth`
- `src/sync/revocation.ts` → revocation flow
- `src/sync/rate-limiter.ts` → per-DID token bucket
- `src/sync/bootstrap.ts` → QR invite gen + accept
- PoC + integration tests per function; full 7-section evaluation per PR
- Ships as 3 stacked PRs

**Track 3 — Phase T (2–3 days) after P lands:**
- `src/trust/anchor.ts` → `pinTrustAnchor`, `revokeTrustAnchor`
- Extend `src/infra/storage/chain-adapter.ts` with `withAppendLockAcrossChains`
- Operator CLI commands: `memphis trust pin/revoke/list/history`
- Ships as 2 PRs

**End of week outcome:** offline invariant gating CI, private tier hermetic,
trust chains operational with audit view.

---

## Verification per sprint

```bash
npm run typecheck && npm run lint
npx vitest run --reporter=dot           # full suite, target: 2054+ tests, 0 regressions
npm audit --omit=dev --audit-level=high # 0 advisories
cargo check --workspace                 # clean
cargo test -p memphis-vault -p memphis-core --lib
npm run test:offline                    # after Phase L lands
```

For Phase G:
```bash
cd apps/memphis-gui && cargo tauri dev    # local smoke
cargo tauri build --target x86_64-unknown-linux-gnu  # .deb artifact
```

---

## Reused utilities (avoid duplication)

- `secureCompare` — `src/security/constant-time.ts:58`
- `writeSecurityAudit` — `src/infra/logging/security-audit.ts`
- `withAppendLock` — `src/infra/storage/chain-adapter.ts:796`
- `verify_block_signature` — `crates/memphis-core/src/signature.rs`
- `realpathOrNearest` — `src/mcp/tools/fs-permission.ts`
- `derive_vault_key_with_2fa_v2` — `crates/memphis-vault/src/two_factor.rs`
- `isInsideMemphisSandbox` — `src/mcp/tools/fs-permission.ts`

---

## Commit / PR conventions

Precedent: PR #127, #141, #146.

- One commit per logical unit within a phase
- PR title: `feat: <phase letter/number> — <short name>`
- PR body: lists functions added with 7-section evaluation, references roadmap phase, standard verification checklist
- Closes corresponding GitHub issue via `Closes #N` trailer

---

_Last updated: 2026-04-17. Reflects session-end state after PR #146 merged._
