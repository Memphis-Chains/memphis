# Memphis v0.2.0-beta.1 — Release Notes (Draft)

**Release type:** Public Beta  
**Package:** `@memphis-chains/memphis-v5`  
**Publish command (when approved):** `npm publish --tag beta`

---

## Highlights

### 🤝 Multi-agent sync (MVP)
This beta introduces first public multi-agent synchronization capabilities, including push/pull and import/export flows to share chain state across agents.

### ⚡ Retrieval and embedding caching
A multi-tier caching layer improves performance in semantic retrieval and embedding-heavy paths, reducing repeated work and improving runtime responsiveness.

### 🔐 Security hardening fixes
Security-focused hardening has been applied, including protections against timing-attack and DoS risk classes, plus stronger chain integrity / rollback behavior.

---

## What’s new since v0.1.0-alpha.1

- N-API Rust bridge integrated into runtime workflows
- Vault foundation with Argon2id + AES-256-GCM
- Embedding/vector retrieval with cosine similarity and cache optimization
- Multi-turn ask→persist→recall with session APIs
- MCP + HTTP API maturity improvements and smoke coverage
- Multi-agent sync commands and beta docs/install pipeline

---

## Breaking changes

**None.**

---

## Known issues / current limitations

1. Multi-agent sync is MVP-grade and still maturing (federation protocol not final).
2. Beta is optimized for local/same-host setups; cross-host remote sync hardening is still in progress.
3. Some advanced cognitive capabilities from earlier vision docs are still under phased rollout.
4. Public package and install flow are beta-level; edge-case platform combinations may still require manual fallback (clone + build).
5. Security posture is significantly improved, but full external audit/compliance pass is not yet complete.

---

## Recommended audience for this beta

- OpenClaw power users who need persistent memory + retrieval
- Teams validating multi-agent memory sharing workflows
- Operators testing hardened local-first memory infrastructure

---

## Feedback request

Please report:
- Sync correctness issues (duplication, conflict behavior, missing records)
- Retrieval quality/perf regressions
- Install/upgrade friction by OS/platform
- Security concerns or unexpected exposure behavior
