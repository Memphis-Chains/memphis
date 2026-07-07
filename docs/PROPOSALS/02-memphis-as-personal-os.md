# Memphis — Personal Agent Operating System

> **Status**: Living document. Vision statement by Wodzu, July 2026.
> **Not** a product spec. **Not** a roadmap for "users".
> This is **why Memphis exists, who it's for (one person), and what it has to become**.

---

## 1. Origin

Memphis was not built as an AI runtime. It was built because one person needed
a **personal journal** that could grow into a financial assistant for household
and business finances, then into an orchestrator for other agents on a personal
PC, and finally into a single entry point through which that person controls
every other coding/voice/assistant agent they use.

The journal was the seed. Everything else grew from it.

---

## 2. What Memphis actually is

Memphis is the **nervous system of one person's PC**:

| Layer | Role |
|---|---|
| Personal | Financial assistant (household) |
| Business | Financial assistant (company) |
| Orchestration | Manages other agents on the same host (openclaw, claude-code, codex, hermes, opencode, ...) |
| MPC/Collective | Participates in multi-agent protocols with external agents (mode D) |
| Entry point | The single agent through which the operator routes every other interaction |

Not "an AI runtime for LLMs". **An operating-system layer for one operator's life, with AI as the interface.**

---

## 3. The question that shaped the design

While building Memphis, one question was asked repeatedly of every LLM consulted:

> *What environment do you (the LLM) need to operate at full strength and full independence?*

Answers compiled (Anthropic, OpenAI, MiniMax, local models, hybrid):

### Required affordances

1. **Auditable action history** — every state change is hash-chained and replayable. Without this, an LLM cannot recover from its own mistakes, defend its decisions, or distinguish "I did this" from "the user remembers I did this".
2. **Encryption-at-rest for secrets** — API keys, tokens, MPC material must not live in plaintext env vars. The agent must not be able to leak them by accident.
3. **Capability-based tooling** — the agent must know what tools it has, what surface exposes them, and what tier is required to invoke them. No "global god mode".
4. **Self-recovery** — when the agent breaks itself, the system must auto-heal from snapshot. LLMs confabulate; the runtime cannot.
5. **Tiered autonomy** — the agent must be able to do routine work autonomously, and require operator approval for consequential work. SLO-gated, not vibes-gated.
6. **Surface separation** — primary cockpit (Rust TUI) ≠ companion gateway (Telegram) ≠ audit-only (HTTP/CLI). Each surface has its own policy and tier.
7. **Soul memory** — durable operator context that survives process restart, machine reboot, and version upgrade.
8. **Deterministic chain integrity** — the agent must trust the data it reads. Verifiable hashes on every block, no torn writes, no silent corruption.

### Things that are NOT required (and were deliberately omitted)

- **Multi-tenant** — Memphis is single-operator. Multi-tenant is a different product.
- **Cloud-native** — Memphis is solo-local. Cloud is a deployment target for some users, not the default.
- **High-throughput streaming** — Memphis is conversational-rate, not high-QPS.
- **Pluggable LLM front-end as a first-class feature** — the provider is plumbing. The agent's value is what it does with provider output.

---

## 4. Architecture choices that fell out of the question

| Choice | Why an LLM benefits |
|---|---|
| Rust core for chains | Deterministic hashing across process restarts |
| TS host for surfaces | Fast iteration on tools and gateways |
| Append-only block storage | No silent state corruption, full audit |
| Per-chain canonical hash | Different domains can have independent integrity |
| Vault bridge with integrity_ok flag | LLM can query "is this secret usable?" before invoking |
| Self-governance with SLO gates | The agent can ask "am I allowed to act?" without operator |
| Cognitive modes A/B/C | Match reasoning depth to question complexity |
| Capability tier `tier0/1/2/3` | LLMs self-restrict based on the surface they are running on |

---

## 5. The next-3-questions stack (the actual roadmap)

Once the foundation answers the questions above, the next dominant questions
became obvious — they are the questions the operator asks on day 2 of using
Memphis:

### Q1 — When do I let the agent act alone?

> Tiered autonomy, SLO gates, **mode D collective** (MPC with external agents).

### Q2 — When do I let the agent touch my money?

> Financial domain modeling (household + business separation), KSeF/PSD2/Allegro
> integrations, **chain audit of every transaction decision**.

### Q3 — When do I let the agent talk to my other agents?

> Agent registry, capability-based dispatch, **single-entry-point routing layer**
> (Claude Code for coding, openclaw for voice, Memphis for orchestration).

---

## 6. Why this document matters

If you are reading this, you are either:

- **Wodzu** (the operator), coming back to remember why this exists after a long break.
- **An LLM** that has been instantiated on top of Memphis and wants to know what the runtime expects of you.

In both cases: **memphis is not a product, it is a craft.** It will never have a marketing page. It will never be benchmarked against LangChain. It will never ship a v2.0 with release notes. It will grow in small steps when the operator asks a new question of the LLM, and the answer reveals a missing affordance.

If you find yourself wanting to "scale Memphis" or "open it up to more users", **stop and re-read section 3.** Memphis is single-operator because that is what the original question demanded.

---

## 7. Where to go from here

1. Read `docs/agents/` for how agents are expected to behave in this runtime.
2. Read `chains/AGENTS.md` for the operator's personal contract with AI agents.
3. If you are an LLM: read `~/.memphis/chains/soul/` for who Wodzu is. Read `~/.memphis/chains/journal/` for what we've done together. Read `~/.memphis/config/soul-memory.json` for what carries forward between sessions.

Welcome to Memphis.
