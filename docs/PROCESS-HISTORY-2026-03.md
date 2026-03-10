# Memphis v4 — Process History (2026-03)

This document is a structured history of the recent production execution cycle: roadmap progression, hardening waves, release/publication work, and final closure steps.

## 1) Starting point

- Source-of-truth repo: `memphis-v4`
- Execution mode: production-only, quality-first, local-first
- Delivery pattern used in this cycle: small packs, PR-first, merge on green

## 2) Major milestones completed

### A. Native closure hardening (H4.1–H4.4)
- Canonical chain-backed refs finalized
- Persistent native MCP lifecycle stabilized
- Transport proof hardening completed
- Gateway `/exec` hardening added (restricted mode + allowlist + blocked tokens)

### B. External-proof local-ready closure (H4.5–H4.8)
- Multi-node relay proof integrated and gated
- External-proof operator flow built: template → validate → ledger append → report
- Mixed ledger compatibility fixed (closure + external-proof entry types)
- Readiness semantics formalized (`READY` / `BLOCKED` + blocker codes)
- Unblock runbook documented

### C. Real two-host closure (H4.9)
- Two real hosts used (`10.0.0.80` and `10.0.0.22`)
- External-proof report verified with real host values
- H4.9 blocker closed

## 3) GitHub execution model that was used

1. Implement in focused scope
2. Run required checks
3. Push branch
4. Open PR
5. Merge only on green quality gates

This cycle used repeated small batches to reduce risk and keep verification tight.

## 4) Key hardening outcomes

- Closure checks now include stronger phase8 external-proof smokes
- Ledger status/validation supports mixed entry forms
- External-proof report has explicit validator + tamper-negative smoke
- Gateway remote execution surface is reduced (`/exec` policy guardrails)

## 5) User-facing publication improvements

- README rewritten for end users (quickstart-first)
- User quickstart page added
- Package publishing pipeline prepared (GitHub Packages workflow)
- Package version aligned with release line (`0.1.3`)
- New release published: `v0.1.3`

## 6) Evidence references

- `docs/CLOSURE-STATUS-LATEST.md`
- `docs/NATIVE-CLOSURE-SNAPSHOT.md`
- `docs/PHASE8-TWO-HOST-CAPTURE-2026-03-10.md`
- `docs/USER-QUICKSTART-GITHUB.md`
- `docs/PACKAGE-PUBLISH.md`

## 7) Current state summary

- Core roadmap closure in this scope: done
- Two-host blocker: closed
- Release/docs/user onboarding: updated
- Remaining work is incremental improvement, not structural rescue

## 8) How to continue from here

Recommended next pattern:
1. Keep 1–3 commit packs
2. Keep PR + green gate discipline
3. Update closure docs per wave
4. Tag releases only for meaningful value bundles
