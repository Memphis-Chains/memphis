# Memphis Runtime Security Architecture

Status: canonical runtime-security note for the current repository.

This document defines the dependency graph and trust boundaries that Memphis must preserve while moving toward `v1.0.0`.

## 1. Authority Layers

### Rust core

Rust is authoritative for deterministic and security-sensitive primitives:

- chain integrity,
- case/index operations,
- vault cryptography,
- loop-step enforcement,
- bridge-level integrity checks.

Rust is not responsible for operator UX, prompt assembly, or surface-specific orchestration.

### TypeScript runtime

TypeScript is authoritative for:

- provider selection,
- prompt assembly,
- tool execution,
- policy resolution,
- sessions and runtime memory flow,
- MCP, gateway, HTTP, CLI, and TUI adapters.

TypeScript must not contradict Rust, and surfaces must not invent their own runtime contracts.

## 2. Trust Boundaries

Memphis has four critical trust boundaries.

### Vault boundary

Vault is the highest-sensitivity subsystem.

Rules:

- secret material must stay inside bounded vault flows,
- secret contents must never be copied into soul memory, journal, prompt fragments, recalled memory, or user-facing output,
- every vault access must be auditable.

### Prompt boundary

The model must see a stable distinction between:

- Memphis-authored system instructions,
- user-authored input,
- fetched external content,
- recalled memory,
- tool results.

User input and fetched content are always untrusted.

### Persistence boundary

Because journal and related memory are append-only, malicious content must be stopped before persistence.

Rules:

- pre-persist content scan before append-only or long-lived writes,
- blocked payloads are not stored raw,
- audit uses metadata-only security events.

### Capability boundary

Tools, approvals, vault access, exec, and self-modify are runtime capabilities, not prompt suggestions.

Rules:

- only registered tools exist,
- tool access comes from runtime policy,
- prompt obedience is never the primary safety mechanism.

## 3. Canonical Runtime Flow

The correct runtime flow is:

1. input arrives from a surface,
2. TypeScript runtime classifies risk and wraps user/external content,
3. prompt is assembled from trusted and untrusted fragments,
4. model runs through a unified provider path,
5. tool calls go through one shared executor and policy layer,
6. outputs pass through output guard,
7. durable writes pass through content scan before persistence,
8. audit events are recorded without storing blocked raw payloads.

## 4. Surface Rules

Every surface must use the same core contracts:

- HTTP
- gateway/channels
- MCP
- CLI
- TUI

Allowed difference:

- UX and presentation.

Forbidden difference:

- provider inventory,
- tool inventory,
- policy semantics,
- memory semantics,
- self-modify gating,
- vault exposure behavior.

## 5. Storage Rules

Canonical runtime root is `~/.memphis` unless overridden.

Required state domains:

- `config/` for mutable runtime config artifacts,
- `chains/` for source-of-truth append-only records,
- `vault/` for encrypted secret storage,
- `embeddings/` for embedding persistence,
- `case-index.sqlite` as a derived index,
- `backups/` for snapshots of the current runtime layout.

Rules:

- chain files are source of truth,
- derived indexes must rebuild from chain files,
- rollback must match the real current layout,
- docs must not describe legacy storage as current truth.

## 6. Current Mandatory Refactor Outcomes

Memphis `v1.0.0` requires all of the following:

- one provider contract,
- one tool contract,
- one authorization/approval path,
- one vault boundary model,
- one prompt boundary model,
- one pre-persist content scan path,
- one rollback story aligned to current storage.

If any of these remain split by surface or by legacy path, Memphis is not yet structurally ready for GA.
