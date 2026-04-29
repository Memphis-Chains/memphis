# Memphis — Codebase Truth Snapshot — 2026-04-27

**This document is descriptive, not prescriptive.** It catalogs the current
state of the codebase: where the spaghetti is, where functions duplicate,
where conventions diverge. Future refactor PRs cite specific findings here
("per CODEBASE-TRUTH §3.2") instead of re-discovering the same surface.

No fixes are proposed. No code changes accompany this commit.

**Snapshot context:** end of the v1.7.0 → v1.7.1 → v1.7.2 release line.
24 hours of operator-blocking bugs (positional args, dup `promptHidden`,
parseBool=1, install/bootstrap order, missing-secret-scan patterns) all
pointed at structural inconsistencies that had never been catalogued.
This is the catalog.

**Total LOC**: 94,665 TypeScript / 24,804 Rust. 8 open issues. 31 CLI
handler modules. 5 storage adapter files. 4-5 install entry points
depending on how you count.

---

## §1. File-size hot spots

Top 10 files by raw LOC (`wc -l`). For each: what it does, why it grew,
natural split points (named, not proposed).

### TypeScript

| File | LOC | Role | Why it grew | Natural split points |
|---|---|---|---|---|
| `src/infra/http/server.ts` | 1860 | Fastify HTTP API + every operator endpoint | Every new endpoint added inline; auth-policy lookup, route registration, body validation, all in one module | per-domain route bundles (vault routes, tier routes, ops routes, chat routes) |
| `src/infra/cli/utils/doctor-v2.ts` | 1656 | `memphis doctor` health checks across all subsystems | Each new subsystem adds a check function; no plugin registry | per-check modules + a registry |
| `src/infra/cli/commands/setup.ts` | 1379 | `memphis init` interactive wizard + provider enrollment | Wizard prompts + connectivity checks + .env emit + agent profile + first-run blocks all inline | wizard prompts vs validation vs persistence |
| `src/gateway/tool-executor.ts` | 1323 | Maps tool calls to handlers, runs them, normalizes errors | Tool catalog grew; each tool has its own dispatch arm | per-tool handler files + one dispatcher |
| `src/mcp/server.ts` | 1303 | MCP stdio + HTTP transport with tool list | Inlines transport, tool registry, and capability negotiation | transport vs tool-registry vs handshake |
| `src/modules/apps/manifest.ts` | 1177 | App manifest loading + validation + lifecycle | Schema + validators + runtime helpers in one | schema vs validator vs runtime |
| `src/app/bootstrap.ts` | 1153 | Container bootstrap, DI wiring, runtime startup | Every new subsystem adds wire-up code; DI graph is implicit | subsystem-init modules + a top-level orchestrator |
| `src/gateway/turn-runtime.ts` | 1118 | Per-turn execution: prompt build, tool calls, persistence | Turn lifecycle stages all inline | per-stage modules (prompt-build, tool-loop, persistence) |
| `src/gateway/system-prompt.ts` | 1109 | System prompt template builder | Many conditional blocks for surface/tier/tools | per-block functions + composer |
| `src/security/vault-boundary.ts` | (audit ref) | Vault read/write/audit boundary | Centralized correctly; large because it's the single boundary | none — keep as one file |

### Rust

| File | LOC | Role | Notes |
|---|---|---|---|
| `crates/memphis-tui/src/app.rs` | **6 250** | TUI state machine, slash commands, render dispatch | S4 split (5-PR refactor) was queued for v1.7.0 then deferred when post-merge app.rs additions tangled the rebase. Largest single file in the project. Natural splits already proposed in S4: `app/commands.rs`, `app/host_results.rs`, `app/tests.rs`, `app/format.rs`, `app/render.rs`. |
| `crates/memphis-operator/src/chat.rs` | 3 760 | Provider chat orchestration + streaming | One module per provider response shape would split this naturally |
| `crates/memphis-operator/src/provider.rs` | 3 047 | Provider configs, auth, request building | Per-provider modules (anthropic, minimax, deepseek, glm) + shared traits |
| `crates/memphis-operator/src/runtime.rs` | 1 424 | Operator runtime errors + state | Recently added `ContextOverflow` variant in #302; fine as-is |
| `crates/memphis-tui/src/client.rs` | 1 111 | `MemphisClient` host-RPC bridge | Recent additions: `reload_env_from_disk` (#296), `set_dotenv` (#308) |
| `crates/memphis-napi/src/lib.rs` | 1 052 | NAPI exports for vault/chain/embed | Single file by NAPI convention; not a refactor target |
| `crates/memphis-embed/src/pipeline.rs` | 997 | Embedding pipeline (just under top-10 cutoff) | OK |

---

## §2. Duplicate-function inventory

### `promptHidden*` — 3 near-identical implementations

| File | Function | Line | Notes |
|---|---|---|---|
| `src/infra/cli/commands/provider.ts` | `promptHiddenSecret(label)` | 37 | **Exported**; used by setup.ts via import |
| `src/infra/cli/handlers/tier.handler.ts` | `promptHiddenPassphrase(label)` | 148 | Adds `MEMPHIS_OPERATOR_PASSPHRASE` env-var fallback for non-TTY |
| `src/infra/cli/handlers/vault.handler.ts` | `promptHidden(label)` | 36 | No env-var fallback |

All three: `emitKeypressEvents` + raw mode + mask with `*` + Ctrl-C + Enter
+ Backspace handlers. ~50 lines each. **~150 lines of copy-pasted code.**

### `getBridgePath` — 5 sites with *almost* identical bodies

| File | Function | Line |
|---|---|---|
| `src/infra/storage/case-chain-adapter.ts` | `getBridgePath` | 45 |
| `src/infra/storage/chain-adapter.ts` | `getRustBridgePath` | 30 |
| `src/infra/storage/rust-embed-adapter.ts` | `getBridgePath` | 54 |
| `src/infra/storage/rust-vault-adapter.ts` | `getBridgePath` | 359 |
| `src/infra/storage/rust-chain-adapter.ts` | `getBridgePath` | 146 |

All five now delegate to `resolveRustBridgePath()` from
`src/infra/runtime/install-root.ts` (post-PR #314), but each module
still wraps it in a 3-line local function. The wrappers are vestigial
— direct import would remove 5 wrappers without behaviour change.

### `parseBool` callers — 13+ files

`src/core/env.ts:11` defines it correctly (post-#320 accepts truthy
set). Imported at:

```
src/providers/conflict-detection.ts
src/infra/cli/provider-capabilities.ts
src/infra/runtime/safe-mode.ts
src/infra/runtime/emergency-log.ts
src/infra/runtime/startup-guards.ts
src/infra/runtime/admin-signature.ts
src/infra/storage/rust-vault-adapter.ts
src/infra/storage/chain-adapter.ts
src/infra/storage/case-chain-adapter.ts
src/infra/storage/rust-embed-adapter.ts
src/infra/logging/metrics.ts
src/federation/mp/signed-transport.ts
src/security/vault-boundary.ts
```

Centralized correctly. No issue here — listed for completeness.

---

## §3. Storage adapter family

Five files in `src/infra/storage/` named like adapters:

### `chain-adapter.ts` (canonical TS-first dispatcher)

- 868+ LOC, 10+ exports
- `getChainAdapterStatus()`, `resolveChainDir()`, `hashBlock()`,
  `AppendBlockResult`, `ChainBlock`, `ChainExportEnvelope`,
  `ChainHashDiagnosis`, `ConfigHistoryEntry`
- **Role**: top-level chain operations façade — auto-selects between
  TS-legacy and Rust-NAPI backend per `RUST_CHAIN_ENABLED`
- **Caller surface**: 10+ files including `bootstrap.ts`, `task-executor.ts`,
  `doctor-v2.ts`, `consent.handler.ts`

### `rust-chain-adapter.ts` (Rust NAPI bridge for chain)

- 144+ LOC of types alone, exports `NapiChainAdapter` class
- Bridge layer when `RUST_CHAIN_ENABLED=true`
- **Caller surface**: `task-executor.ts`, `chain-query.ts`,
  `storage.handler.ts`, `health-monitor.ts`, `mcp/server.ts`,
  `infra/http/server.ts`, plus `chain-adapter.ts` itself

### `case-chain-adapter.ts` (per-case chain wrapper, separate from chain-adapter)

- Exports single `CaseChainAdapter` class
- Used for the 8 "case role" chains (decisions, reflections, journal, etc.)
- **Caller surface**: `bootstrap.ts`, `interaction.ts`, `seed.ts`,
  `mcp/server.ts`, `gateway/authorization.ts`, `mcp/tools/soul.ts`,
  `worker.handler.ts`, `case-chain.test.ts`

### `rust-vault-adapter.ts` and `rust-embed-adapter.ts`

Bridge layers for vault and embed; less ambiguity — each has a single
clear role.

**Boundary findings:**

1. The TS-legacy backend in `chain-adapter.ts` is now rarely-used
   (`RUST_CHAIN_ENABLED=true` is the production default) but the dispatch
   logic is kept "just in case". Whether that's intentional or
   not-yet-cleaned-up is undocumented.
2. `chain-adapter.ts` and `rust-chain-adapter.ts` have **partially
   overlapping caller sets** — some callers go directly to Rust adapter,
   some go through the dispatcher. No documented rule for which is right.
3. `case-chain-adapter.ts` is name-similar but conceptually distinct
   (it's a per-chain WRAPPER, not a backend ALTERNATIVE). Naming creates
   confusion.

---

## §4. Install / bootstrap / init path proliferation

Five entry points that all touch first-run state:

| Path | LOC | Role | When operator hits it |
|---|---|---|---|
| `scripts/install.sh` | 583 | The one-liner: clones repo, npm install + build + link, runs bootstrap, optionally runs `memphis init` (post-#316) | `curl ... \| bash` |
| `scripts/bootstrap.sh` | 333 | Creates .env from .env.example, generates random API token + vault pepper, ensures agent profile, optionally installs systemd unit | `npm run bootstrap` (now also auto-called by install.sh) |
| `scripts/install-prerequisites.sh` | 197 | apt/dnf prerequisites: Node 22, Rust, Ollama, ffmpeg, etc. | called by install.sh |
| `scripts/fresh-install/06-fresh-install-and-restore.sh` | 207 | Snapshot existing → tear-down → fresh install → restore. Disaster-recovery audit | operator-driven on second-host migration |
| `src/infra/cli/commands/setup.ts` (`memphis init`) | 1379 | Interactive wizard: profile → vault init → operator passphrase → first-run blocks. Auto-creates .env if missing post-#316 | `memphis init` (manual or via `--with-init`) |

**Path overlap:**

- `.env` creation: `bootstrap.sh` (cp template + populate tokens) **and**
  `memphis init` auto-create path (post-#316, just cp). Two implementations.
- Vault pepper: `bootstrap.sh:53-55` generates `memphis-{16-byte-hex}`,
  `setup.ts` generates differently via `generateVaultPepper()` helper.
- Agent profile: `bootstrap.sh:140-178` writes a default profile,
  `setup.ts:writeAgentProfile()` writes it differently with operator-supplied
  name. Operator gets one or the other depending on which path runs first.
- systemd unit: `bootstrap.sh:104+` runs `memphis service install`,
  install.sh has its own logic (line 540 `npm link`) but doesn't install
  the unit, `06-fresh-install-and-restore.sh` is the only one that explicitly
  manages systemctl.

**Operator-canonical path** (per README): `curl ... install.sh | bash -s -- --with-init`.
That now works end-to-end post-#316. The other paths exist for power users
and migration scenarios but have never been documented as a hierarchy.

---

## §5. Dispatcher / handler / auth-gating matrix

**Total handlers**: 31 (`src/infra/cli/handlers/*.handler.ts`)

**Handlers calling `requireOperatorAuth()`**: **1 — only `vault.handler.ts`**

**Handlers NOT calling `requireOperatorAuth()`**: 30, including:

```
apps.handler.ts          audit.handler.ts        auth.handler.ts
cognitive.handler.ts     config.handler.ts       consent.handler.ts
debug.handler.ts         decision.handler.ts     embed.handler.ts
evolve.handler.ts        explain.handler.ts      interaction.handler.ts
kartograf.handler.ts     knowledge.handler.ts    mcp.handler.ts
operator.handler.ts      provider.handler.ts     schedule.handler.ts
search.handler.ts        secret.handler.ts       skills.handler.ts
storage.handler.ts       sync.handler.ts         system.handler.ts
telegram.handler.ts      tier.handler.ts         tools.handler.ts
trust.handler.ts         worker.handler.ts       evolve.handler.ts
```

**Critical asymmetries**:

| Handler | Has destructive ops? | Gates them? |
|---|---|---|
| `vault` | YES (add/delete/reset/rotate) | YES — gates ALL ops including `list`/`get` (asymmetric — over-gates reads) |
| `evolve` | YES (self-modification) | NO |
| `secret` | YES (writes secrets) | NO |
| `tier` | YES (privilege elevation) | per-op (elevate uses passphrase as the operation, not as a gate) |
| `worker` | YES (job mutation) | NO |
| `telegram` | YES (bot token, allowed users) | NO |
| `consent` | YES (consent records) | NO |
| `schedule` | YES (scheduled tasks) | NO |
| `trust` | YES (trust rules add/remove) | NO |
| `provider` | YES (writes API keys via storeVaultSecret) | NO |

**Reference** — issue #278 ("CLI lacks per-command auth — local-host
adversary can memphis exec / vault ops without passphrase") covers this
exact matrix. Currently filed at P1.

---

## §6. Error-message inconsistency catalog

Pattern A (gold standard, post-#307/#321):
> `<command> requires a key. Pass it as 'memphis vault add <name>' or 'memphis vault add --key <name>'.`

Pattern B (flag-only):
> `Missing required --input for chat/ask command`

Pattern C (verbose with examples):
> `Provider name required: memphis provider add <anthropic|minimax|...> --api-key <key>`

| Site | File:line | Current pattern | Both forms shown? |
|---|---|---|---|
| `vault add` | `vault.handler.ts:189` | A (with #321) | YES |
| `vault get` | `vault.handler.ts:281` | A (with #321) | YES |
| `vault entry-delete` | `vault.handler.ts:314` | A (with #321) | YES |
| `ask`/`chat` | `interaction.ts:116-117` | B | NO (only flag mentioned) |
| `provider add` (no name) | `provider.ts:238` | C | NO (only flag form shown) |
| `trust add` | `trust.ts:39` | A (variant) | YES |
| `trust remove` | `trust.ts:80` | A (variant) | YES |
| `kartograf verify` | `kartograf.ts:74` | A (variant) | YES |
| `schedule add` | `schedule.ts:124` | C | NO (flags only) |

**Score**: 6/9 follow Pattern A. The 3 outliers (ask/chat, provider add,
schedule add) are concrete future-PR targets.

---

## §7. Open issues mapped to code

8 open issues at snapshot time:

| # | Title | Severity | Code locations | PR status |
|---|---|---|---|---|
| #270 | SEGV on shutdown — pino flush + cleanup races | P1 | `crates/memphis-napi/src/lib.rs`, `src/infra/runtime/graceful-shutdown.ts`, `src/infra/logging/pino.ts` | None — needs Rust shutdown ordering fix |
| #271 | Singleton races in scheduler/loop/vault adapters | P1 | `src/infra/runtime/scheduler.ts:689`, `src/mcp/tools/loop-step.ts:18`, `src/infra/storage/rust-vault-adapter.ts:153` | None — Promise-based init guard pending |
| #272 | ed25519 seed file 0600 perms | P1 | (re-evaluated) — seed lives in vault, not separate file | **Closed by #319** (vault file 0600 covers it) |
| #274 | secret-scan missing Stripe / Mistral / OpenAI sk- patterns | P2 | `scripts/secret-scan.sh`, `tools/training/kartograf-corpus.py` | **PR #319 open** (partial fix) |
| #275 | vault-entries.json / vault-state.json missing 0600 chmod | P2 | `src/infra/storage/vault-entry-store.ts:46` + 5 sites in `rust-vault-adapter.ts` | **PR #319 open** |
| #276 | Vault secret untracking masks Zod errors | P2 | `src/security/vault-resolve.ts` (likely) | None — truth-model rollout target |
| #277 | EventListener leak in monitorRuntime | P2 | `src/infra/cli/commands/debug.ts:247` | **PR #319 open** (defensive cleanup) |
| #278 | CLI per-command auth gap | P1 | All 30 handlers in §5 | None — broad design sprint |

**Roadmap items** (different category): #160 memphis-ml viability spike,
#161 Phase 4.5 Agora adversarial simulation. Out of scope here.

---

## §8. Test coverage spot-check

Method: `grep -rln "import.*<file-stem>" tests/ | wc -l` per top-LOC file.
Counts test FILES that import the module (not assertions). Higher = more
coverage; ratio LOC/test-files is the under-tested signal.

| File | LOC | Test files importing | LOC per test file | Verdict |
|---|---|---|---|---|
| `crates/memphis-tui/src/app.rs` | 6 250 | 47 | ~133 | Good (heaviest tested) |
| `src/infra/http/server.ts` | 1 860 | 22 | ~85 | Good |
| `src/mcp/server.ts` | 1 303 | 22 | ~59 | Good |
| `crates/memphis-operator/src/provider.rs` | 3 047 | 21 | ~145 | Acceptable |
| `crates/memphis-operator/src/chat.rs` | 3 760 | 10 | ~376 | **Under-tested** (largest LOC/test ratio) |
| `src/app/bootstrap.ts` | 1 153 | 6 | ~192 | Acceptable |
| `src/gateway/tool-executor.ts` | 1 323 | 5 | ~265 | **Under-tested** |
| `src/infra/cli/utils/doctor-v2.ts` | 1 656 | 3 | ~552 | **Severely under-tested** |
| `src/infra/cli/commands/setup.ts` | 1 379 | 3 | ~460 | **Severely under-tested** |
| `src/gateway/turn-runtime.ts` | 1 118 | 1 | ~1118 | **Critically under-tested — single test file** |

**Bottom 4 (LOC per test file > 250)** are the highest-risk files for
silent regressions. Notable: `turn-runtime.ts` has ONE test file despite
being on the per-turn hot path. `doctor-v2.ts` and `setup.ts` are both
operator-facing first-run code paths — flakes here block install.

---

## Snapshot integrity

- `npx tsc --noEmit` clean at snapshot time (no code modified).
- All `src/` LOC counts via `wc -l` 2026-04-27.
- All issue mappings via `gh issue list --state open` 2026-04-27.
- All handler counts via `ls src/infra/cli/handlers/*.handler.ts | wc -l`.

Future snapshots: re-run the same commands, `diff` against this file.
Pattern: `docs/dev/CODEBASE-TRUTH-<YYYY-MM-DD>.md`. Do NOT overwrite —
trail of snapshots is the value.
