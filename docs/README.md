# Memphis Documentation

**Single entry point for all Memphis runtime documentation.** Version v1.13.3 (September 2026).

If you are new here, start with **[operator/GETTING-STARTED.md](operator/GETTING-STARTED.md)**. If you are an integrator, start with **[dev/DEVELOPER.md](dev/DEVELOPER.md)**. If you are looking for a specific topic, use the directory map below.

---

## Directory map

| Directory | What's in it | When to read |
|---|---|---|
| **[adr/](adr/)** | Architecture Decision Records (5 files) | When you need rationale for past design choices |
| **[agents/](agents/)** | Agent-to-agent integration specs (1 file: OpenClaw) | When integrating Memphis as another agent's substrate |
| **[api/](api/)** | HTTP/CLI/typedoc API references | When building against Memphis programmatically |
| **[briefs/](briefs/)** | Task briefs sent to sub-agents (mcode/Mavis) | When you need to understand what another agent was told to do |
| **[dev/](dev/)** | Deep technical docs (~70 files) — architecture, cognitive, security, embed, NAPI | When hacking on Memphis internals |
| **[diagrams/](diagrams/)** | Mermaid source for system diagrams | When you need visual reference, render via mermaid.live |
| **[issues/](issues/)** | GitHub-issue-format reports (incl. current MiniMax partnership proposal) | When you need to know what was reported or proposed externally |
| **[observability/](observability/)** | Grafana dashboard JSON | When wiring monitoring |
| **[operator/](operator/)** | Day-to-day operator docs (~70 files) — install, run, troubleshoot, vault, voice | When you are the operator (this is your home directory) |
| **[partnerships/](partnerships/)** | Outreach materials for external partners (MiniMax, future B2B) | When initiating or following up on partnership conversations |
| **[pitch/](pitch/)** | Pitch decks (HTML + PDF) | When you need a printable summary for prospects or partners |
| **[postmortems/](postmortems/)** | Post-incident analyses | When something breaks and you want to understand why |
| **[PROPOSALS/](PROPOSALS/)** | Forward-looking product proposals | When planning future work or pitching product direction |
| **[releases/](releases/)** | Version release notes | When you want to know what changed in a specific release |
| **[rfc/](rfc/)** | Request-for-comments proposals (1 file: vault Shamir recovery) | When designing non-trivial new features |
| **[roadmap/](roadmap/)** | Forward-looking roadmap + Y1 plan + public FAQ | When planning future work or explaining direction to stakeholders |
| **[runbooks/](runbooks/)** | Operational runbooks for specific scenarios | When handling incidents or scheduled maintenance |
| **[snapshots/](snapshots/)** | Point-in-time snapshots (codebase, capabilities) | When you need historical "this was the state at X" reference |

---

## Top-level meta-docs

These docs govern the docs themselves (cross-cutting concerns):

- **[VERSION-MAP.md](VERSION-MAP.md)** — canonical mapping: "I'm reading docs for v1.13.3 — which docs are current, which are obsolete?"
- **[ARCHIVE-POLICY.md](ARCHIVE-POLICY.md)** — what goes where when content becomes historical (archive/ vs historical/)

---

## Project Status

The canonical record of what the runtime is and is not, kept with the historical
docs so the claims stay auditable:

- **[historical/PROJECT-STATUS.md](historical/PROJECT-STATUS.md)** — operator-facing status statement
- **[historical/PUBLISH-STATUS.md](historical/PUBLISH-STATUS.md)** — what is published vs unreleased
- **[historical/EXECUTION-PLAN.md](historical/EXECUTION-PLAN.md)** — how the current state of `main` was reached

## Current roadmap

- **[ROADMAP-CURRENT.md](ROADMAP-CURRENT.md)** — the live roadmap
- **[../docs/roadmap/current-priorities.md](roadmap/current-priorities.md)** — this week's auto-generated priorities, regenerated every Tuesday from the real state of issues, PRs, branches and CI

## Clean Install

- **[operator/CLEAN-INSTALL.md](operator/CLEAN-INSTALL.md)** — from a clean machine to a running runtime
- **[../CHANGELOG.md](../CHANGELOG.md)** — release history

---

## README

This is the main entry point. For per-directory README files, see the directory itself.

### Why this exists

307 markdown files across 22 directories is too many to discover by browsing. This README is the single map. If you find yourself hunting for a doc, **update this file** — that's the price of admission for adding a new top-level directory.

### Related

- AGENTS.md (root, Memphis-Chains/memphis) — agent-facing manifest for coding agents
- README.md (root, Memphis-Chains/memphis) — user-facing repo entry point (already public)
