# Soul Guide — MemphisOS Agent Identity & Memory System

> Status: advisory reference for the `soul-*` identity and memory surfaces.
> Canonical product truth lives in `README.md`, `docs/CANONICAL-ARCHITECTURE.md`,
> and `docs/RUNTIME-STATE-MODEL.md`.
>
> **What is Soul?** `soul-*` is the compatibility name for Memphis identity and
> memory storage: manifest, operator preferences, and optional onboarding seed
> data stored as auditable chain entries and structured JSON files. It is not a
> claim of personhood or the canonical product definition.

---

## Table of Contents

1. [Architecture](#1-architecture)
2. [Soul Components](#2-soul-components)
3. [Agent Profile](#3-agent-profile)
4. [Soul Seeding](#4-soul-seeding)
5. [Runtime Identity Wiring](#5-runtime-identity-wiring)
6. [Soul CLI Commands](#6-soul-cli-commands)
7. [Doctor Integration](#7-doctor-integration)
8. [Case Chain (Polish Grammatical Cases)](#8-case-chain-polish-grammatical-cases)

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Soul System                                    │
│                                                                      │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────────┐  │
│  │ Soul Manifest│   │ Soul Memory   │   │ Soul Seeding           │  │
│  │ (JSON)       │   │ (JSON)        │   │ (Idempotent bootstrap) │  │
│  │              │   │               │   │                        │  │
│  │ identity     │   │ user prefs    │   │ 5 journal entries      │  │
│  │ capabilities │   │ self-knowledge│   │ 8 case chain entries   │  │
│  │ boundaries   │   │ learnings     │   │                        │  │
│  │ evolution    │   │ context       │   │ Auto-runs on first     │  │
│  │ mode/trust   │   │               │   │ boot if memory empty   │  │
│  └──────┬───────┘   └──────┬───────┘   └────────────┬─────────────┘  │
│         │                  │                          │                │
│         └──────────┬───────┘                          │                │
│                    ▼                                    ▼                │
│         ┌──────────────────────────────────────────────────────┐       │
│         │          System Prompt (src/gateway/system-prompt.ts) │       │
│         │   Agent name, owner name, identity injected at runtime │       │
│         └──────────────────────────────────────────────────────┘       │
│                              │                                          │
│         ┌─────────────────────┴──────────────────────────────────┐      │
│         │              Memphis Runtime                             │      │
│         │  Rust NAPI (chain integrity, embeddings, vault)         │      │
│         │  TypeScript orchestration (tools, gateway, CLI, TUI)     │      │
│         └─────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Controlled first-run**: `npm run bootstrap` handles technical install only. `memphis init` is the explicit step that creates first meaningful identity/memory chains.
2. **Manifest generation**: `ensureSoulManifest()` reads agent profile + chain status → writes `soul-manifest.json`
3. **Identity wiring**: `buildSystemPrompt()` injects `agentName`/`ownerName` from resolved profile into every LLM conversation
4. **Memory update**: `memphis_soul_write` MCP tool updates `soul-memory.json` via deep merge
5. **Audit trail**: Soul writes are mirrored to the case chain (genitive + accusative entries) for chain-backed accountability

---

## 2. Soul Components

### Soul Manifest (`soul-manifest.json`)

Auto-generated on every boot. Captures the agent's current identity, capabilities, and boundaries.

```typescript
interface SoulManifest {
  schemaVersion: 1;
  generatedAt: string; // ISO timestamp
  identity: {
    agentName: string; // e.g. "Memphis Agent"
    ownerName: string; // e.g. "Marcin"
    did?: string; // optional DID
    runtimeMode: string; // e.g. "solo-local"
    createdAt: string; // ISO timestamp of first boot
  };
  capabilities: {
    tools: string[]; // available MCP tools
    chains: string[]; // chain types (journal, decisions, etc.)
    channels: string[]; // active channels (cli, http, telegram, mcp)
    providers: string[]; // LLM providers
    rustBridge: boolean; // whether Rust NAPI is loaded
  };
  boundaries: {
    tier0: { auth: 'none'; scope: string };
    tier1: { auth: 'api_token'; scope: string };
    tier2: { auth: 'vault_passphrase'; scope: string };
  };
  evolution: {
    autoApproveReflections: boolean;
    requirePassphraseForTier2: boolean;
    passphraseHash?: string;
    snapshotBeforeEvolution: boolean;
  };
  mode: 'quiet' | 'balanced' | 'paranoid';
  trustRules: TrustRule[];
}
```

Storage: `data/config/soul-manifest.json`

### Soul Memory (`soul-memory.json`)

Persistent identity memory that survives across conversations and reboots. Written by `memphis_soul_write` tool.

```typescript
interface SoulMemory {
  schemaVersion: 1;
  lastUpdated: string; // ISO timestamp
  user: {
    name?: string;
    languages: string[]; // e.g. ['pl', 'en']
    preferences: string[]; // e.g. ['concise responses', 'sprint workflow']
    expertise: string[]; // e.g. ['Rust', 'TypeScript', 'cryptography']
    integrations: string[]; // e.g. ['ollama', 'minimax', 'telegram']
  };
  self: {
    personality?: string; // e.g. 'Direct, bilingual (PL/EN), technically precise'
    strengths: string[]; // e.g. ['chain-backed memory', 'semantic recall']
    learnings: string[]; // runtime-discovered facts
    evolvedCapabilities: string[];
  };
  context: {
    activeWork?: string; // current task
    recentDecisions: string[]; // decision chain summaries
  };
}
```

Storage: `data/config/soul-memory.json`

### Source Files

| File                   | Purpose                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/soul/types.ts`    | All TypeScript interfaces and Zod schemas                                                                    |
| `src/soul/manifest.ts` | Manifest generation, loading, persistence (`ensureSoulManifest`, `loadSoulManifest`, `generateSoulManifest`) |
| `src/soul/memory.ts`   | Memory loading, writing, deep merge updates (`loadSoulMemory`, `updateSoulMemory`, `isSoulMemoryEmpty`)      |
| `src/soul/seed.ts`     | Explicit soul/bootstrap helpers for legacy or manual use                                                     |
| `src/soul/boot.ts`     | Historical boot helpers retained as compatibility/reference material                                         |

---

## 3. Agent Profile

The agent profile is the canonical source of identity: `agentName`, `ownerName`, `runtimeMode`, `toolPolicy`, and `behaviorRules`.

### Resolution Order

```
1. data/config/agent-profile.json  → if exists, use it (highest priority)
2. MEMPHIS_AGENT_NAME / MEMPHIS_OWNER_NAME env vars  → build from env
3. Defaults  → "Memphis Agent" / "local operator"
```

### Default Profile

```json
{
  "schemaVersion": 1,
  "agentName": "Memphis Agent",
  "ownerName": "local operator",
  "runtimeMode": "solo-local",
  "toolPolicy": "operator-supervised",
  "behaviorRules": [
    "Operate locally and keep durable memory auditable.",
    "Use tools deliberately and prefer reversible actions.",
    "Treat vault-managed secrets as operator-controlled state."
  ]
}
```

### Setup & Onboarding

The canonical operator-first path is now `memphis init`, not the old onboarding wizard. Identity and first-state wiring happens through explicit init flow rather than hidden boot-time soul seeding.

The agent profile file (`data/config/agent-profile.json`) is read by the soul manifest on every boot.

Source: `src/infra/agent-profile.ts`

### Environment Override

```bash
MEMPHIS_AGENT_NAME="Memphis Agent"
MEMPHIS_OWNER_NAME="Marcin"
```

---

## 4. Soul Seeding

Historical note: older Memphis flows auto-seeded baseline identity and memory on
boot. Current product truth is stricter:

- `bootstrap` is technical install only,
- `memphis init` owns controlled first-state creation,
- `memphis soul seed` remains an explicit legacy/manual tool, not the canonical first-run path.

### What Gets Seeded

When explicit seeding is invoked manually:

1. **Soul Memory** — initializes with user prefs, personality, strengths, learnings, and context
2. **Journal Chain** — 5 foundational entries written to `chains/journal/`:
   - `soul-seed:identity` — agent identity, owner, local runtime stance
   - `soul-seed:architecture` — Rust crates, TypeScript runtime, chains, auth tiers
   - `soul-seed:capabilities` — all available tools (journal, recall, decide, exec, vault, etc.)
   - `soul-seed:providers` — configured provider stack and fallback stance
   - `soul-seed:boundaries` — self-modification rules, tier auth, operator constraints
3. **Case Chain** — 8 entries (one per Polish grammatical case) encoding the agent's identity semantically:
   - **nominative** (kto? co?) — agent exists as a local Memphis runtime
   - **genitive** (kogo? czego?) — chain-backed memory, encrypted vault, derived recall indexes
   - **dative** (komu? czemu?) — auditable local assistance for the operator
   - **accusative** (kogo? co?) — orchestrates tools, chains, decisions
   - **instrumental** (kim? czym?) — Rust NAPI bridge + TypeScript runtime
   - **locative** (gdzie? w czym?) — local machine, Memphis runtime, systemd
   - **ablative** (skąd? od kogo?) — from blank state to initialized runtime
   - **vocative** (o kogo? o co?) — operator invokes via CLI, TUI, HTTP, MCP

### Current Triggers

- **CLI**: `memphis soul seed` (manual / explicit legacy workflow)
- **Controlled onboarding**: `memphis init --state guided-conversation` for canonical first meaningful state creation

### 50ms Yield Between Writes

Soul seeding writes 13 entries total (5 journal + 8 case chain). Each append waits 50ms to prevent Rust NAPI lock contention during rapid chain writes.

Source: `src/soul/seed.ts`

---

## 5. Runtime Identity Wiring

The system prompt is the runtime identity card — it is injected into every LLM conversation via `buildSystemPrompt()` in `src/gateway/system-prompt.ts`.

### What Gets Injected

The `<identity>` section of the system prompt is built from the resolved agent profile:

```
You are {agentName}, a local-first Memphis agent runtime operating on {ownerName}'s machine.
Your owner is {ownerName}. You speak Polish and English.
You are operator-supervised, not a cloud service. You run locally via systemd (memphis.service) or the foreground runtime.
```

### Agent Profile Wiring

The gateway (`src/gateway/chat-loop.ts`) resolves the agent profile and passes `agentName`/`ownerName` into the system prompt context:

```typescript
const { profile } = resolveAgentProfile(rawEnv);
const systemPrompt = buildSystemPrompt({
  agentName: profile.agentName,
  ownerName: profile.ownerName,
  // ... chain stats, tools, etc.
});
```

### Soul Memory Injection

At boot, if soul memory is empty, a special `<soul_boot>` fragment is injected prompting the agent to collect user preferences via `memphis_soul_write`.

For established agents, soul memory and manifest are available via `memphis_soul_read` tool at conversation start.

---

## 6. Soul CLI Commands

All accessed via `memphis soul <subcommand>`:

### `memphis soul show`

Displays the current soul manifest (identity, capabilities, boundaries, mode, trust rules).

### `memphis soul memory`

Displays the current soul memory (user prefs, self-knowledge, context).

### `memphis soul seed`

Manually triggers soul seeding. Idempotent — skips if already seeded.

```
Output:
  Soul seed complete:
    Soul memory: initialized
    Journal entries: 5/5
    Case entries: 8/8
```

### `memphis soul replay`

Replays soul-seed journal entries back from the chain.

### `memphis soul step`

Advances the soul loop state machine (used by Rust NAPI bridge).

### `--json` Flag

All soul commands support `--json` for machine-readable output.

---

## 7. Doctor Integration

The active first-run gate is now `t1-first-run-contract`, with `t1-soul-manifest`
as an optional compatibility surface:

| Check                | ID                      | Tier            | Description                                                             |
| -------------------- | ----------------------- | --------------- | ----------------------------------------------------------------------- |
| Controlled first-run | `t1-first-run-contract` | 1 (required)    | Verifies env, operator, vault, and explicit first-run state are present |
| Soul manifest        | `t1-soul-manifest`      | 1 (recommended) | Verifies the advisory soul manifest exists                              |

**Check behavior:**

- **OK**: first-run completed and manifest present
- **WARN**: first-run incomplete or manifest missing
- **Fix**: `memphis doctor --fix` now points operators to `memphis init` / `memphis repair runtime`; it does not silently auto-seed soul state

---

## 8. Case Chain (Polish Grammatical Cases)

The case chain encodes the agent's baseline runtime identity using all 8 case
types. Each case is a `CaseEntry` appended to `chains/cases/`:

| Case         | Polish Name | Question       | Encodes                                    |
| ------------ | ----------- | -------------- | ------------------------------------------ |
| Nominative   | Mianownik   | kto? co?       | Agent exists as local runtime              |
| Genitive     | Dopełniacz  | kogo? czego?   | Possessed: chain memory, vault, embeddings |
| Dative       | Celownik    | komu? czemu?   | Recipient: auditable assistance for owner  |
| Accusative   | Biernik     | kogo? co?      | Orchestrates: tools, decisions, chains     |
| Instrumental | Narzędnik   | kim? czym?     | Means: Rust NAPI + TypeScript runtime      |
| Locative     | Miejscownik | gdzie? w czym? | Location: local machine, systemd service   |
| Ablative     | Ablativus   | skąd? od kogo? | Blank state to initialized runtime         |
| Vocative     | Wołacz      | o kogo? o co?  | Operator invokes via CLI, TUI, HTTP, MCP   |

The case chain is indexed by the Rust embedding pipeline for semantic query. Source: `src/infra/storage/case-chain-adapter.ts`.

---

## Source Reference

| File                                        | Purpose                                  |
| ------------------------------------------- | ---------------------------------------- |
| `src/soul/types.ts`                         | All interfaces and Zod schemas           |
| `src/soul/manifest.ts`                      | Manifest generation and persistence      |
| `src/soul/memory.ts`                        | Memory loading, writing, and deep merge  |
| `src/soul/seed.ts`                          | Idempotent first-boot seeding            |
| `src/soul/boot.ts`                          | Boot-time helpers and fragment builders  |
| `src/infra/agent-profile.ts`                | Agent profile resolution and persistence |
| `src/gateway/system-prompt.ts`              | Runtime system prompt generation         |
| `src/gateway/chat-loop.ts`                  | Gateway loop with profile wiring         |
| `src/app/bootstrap.ts`                      | Auto-seeding on HTTP server start        |
| `src/infra/cli/handlers/storage.handler.ts` | `memphis soul *` CLI commands            |
| `src/infra/cli/utils/doctor-v2.ts`          | `t1-soul-identity` doctor check          |
