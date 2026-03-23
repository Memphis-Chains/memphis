# Hotel Deployment Reference

Status: advisory reference

Scope:

- optional deployment patterns for hospitality environments
- optional Synjar and PMS-style integrations
- not the canonical source of truth for Memphis core architecture

Use this document together with:

- `README.md`
- `docs/GETTING-STARTED.md`
- `docs/CANONICAL-ARCHITECTURE.md`
- `docs/EXECUTION-PLAN.md`

## 1. What Memphis already provides

Memphis core already gives you:

- local-first runtime control through CLI, TUI, HTTP, and MCP
- chain-backed durable memory via `POST /api/journal`
- semantic recall via `POST /api/recall`
- encrypted vault state with local operator control
- Rust-backed deterministic primitives exposed through NAPI
- optional channel gateway support instead of mandatory chat-channel coupling

Those are real core capabilities. They do not require Synjar, OpenClaw, or hotel-specific code.

## 2. What a hotel deployment additionally needs

A hotel or regulated on-prem environment usually needs more than the Memphis core path:

- multiple specialized agent roles
- optional document retrieval against policies, manuals, or SOPs
- integration with PMS, access control, payments, or room automation
- retention and redaction rules for guest data
- stronger backup, restore, and incident-export procedures
- explicit observability and operator runbooks

These should be built as downstream integrations, not baked into Memphis core.

## 3. Recommended deployment model

Recommended shape:

- one Memphis runtime as the local control plane
- optional downstream channel or UX integrations
- optional downstream retrieval adapter for document knowledge
- managed apps or MCP tools for system-specific integrations

This preserves the core Memphis stance:

- offline-first by default
- local-first runtime is canonical
- all integrations are optional and configurable

## 4. Synjar as an optional knowledge layer

Synjar fits Memphis as a downstream knowledge adapter, not as a core dependency.

Use it when you need:

- document ingestion and retrieval across many files
- separate knowledge workspaces outside Memphis durable memory
- operator-managed RAG for hotel manuals, check-in procedures, or guest-service policies

Recommended integration patterns:

- MCP tool that wraps Synjar search
- managed app that exposes Synjar-backed retrieval actions
- HTTP adapter that translates Memphis tool calls into Synjar queries

Do not treat Synjar as required for Memphis memory correctness. Memphis memory remains:

- journal and chain as source of truth
- embeddings as recall acceleration
- optional external retrieval as a downstream augmentation layer

## 5. PMS and hotel-system integration pattern

For PMS, automation, and booking flows, prefer one of these patterns:

- managed app with explicit lifecycle and vault-bound secrets
- MCP server that exposes narrow operational tools
- HTTP adapter with explicit auth and audit boundaries

Good examples of tool boundaries:

- `get_booking`
- `update_guest_profile`
- `room_control`
- `create_maintenance_ticket`
- `lookup_policy`

Do not hardwire vendor-specific PMS logic into Memphis core runtime.

## 6. Multi-agent model

A hotel deployment may eventually run multiple agents such as:

- reception
- concierge
- housekeeping
- maintenance

Current Memphis direction supports this best when:

- agents share one Memphis backend intentionally
- identity and policy are explicit per agent
- shared memory use is governed, not accidental
- sensitive domains are partitioned through tags, profiles, or downstream policy layers

This is a future-hardening area, not a claim that Memphis already ships full regulated multi-agent governance.

## 7. Data handling guidance

For guest data and operational data, treat these as separate concerns:

- Memphis durable memory: operator-approved, chain-backed memory that should be auditable
- external document retrieval: policy manuals, SOPs, public or internal docs
- secrets: always in vault or vault-bound app bindings
- backups: explicit and tested, not implied

Recommended operational stance:

- enable embedding persistence
- initialize vault before real use
- define backup cadence for `~/.memphis`, local data dir, and relevant config
- document what content is allowed into durable memory
- define how guest data is redacted or retained over time

## 8. What should stay out of canonical core docs

Do not move these into canonical architecture unless implemented and supported in core:

- Synjar as a required dependency
- hotel-specific workflows as default product behavior
- PMS vendor contracts as first-class Memphis APIs
- speculative plugin systems or infrastructure not actually shipped in the repo

## 9. Practical next steps

For Memphis core:

- follow the source-first bootstrap path in `README.md`
- validate runtime health with `memphis doctor` and `/health`
- prove durable memory with `embed store` and `embed search`

For downstream hotel work:

- define one retrieval adapter pattern for Synjar
- define one PMS integration boundary as managed app or MCP tool
- define retention, redaction, and backup rules before handling real guest data

## 10. Relationship to the roadmap

This document informs the `Post-P2` roadmap in `docs/EXECUTION-PLAN.md`, especially:

- `P4. Optional integrations layer`
- `P5. Governance and recovery`

It is deliberately advisory. The canonical product truth remains in the architecture and execution docs.
