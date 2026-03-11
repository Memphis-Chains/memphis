# Memphis v5 Release Schedule

**Current planning baseline:** `v0.2.0-beta.1`  
**Last updated:** 2026-03-11

---

## 1) Version History

| Version | Date | Status | Summary |
|---|---:|---|---|
| v0.1.0-alpha.1 | 2026-03 | Released | Initial scaffold and runtime baseline |
| v0.1.0-alpha.2 | 2026-03 | Released | Blueprint port, core modules, NAPI foundation |
| v0.1.0-alpha.3 | 2026-03 | Released | CLI/API improvements, metrics/policy tracks |
| v0.1.0-alpha.4 | 2026-03 | Released | Ask-persist-recall and session path hardening |
| v0.2.0-beta.1 | 2026-03-11 | Current | Public beta, sync MVP, docs/install maturity |

---

## 2) Upcoming Releases (Planned)

| Version | Target Date | Focus |
|---|---:|---|
| v0.3.0 | 2026-04-15 | Stability and release reliability |
| v0.4.0 | 2026-05-28 | Security hardening baseline |
| v0.5.0 | 2026-06-30 | Performance optimization I |
| v0.6.0 | 2026-08-12 | Performance optimization II and scale |
| v0.7.0 | 2026-09-24 | Enterprise governance controls |
| v0.8.0 | 2026-10-29 | Ecosystem and integration maturity |
| v0.9.0 | 2026-12-03 | v1 readiness and release candidates |
| v1.0.0 | 2027-01-15 | General availability + LTS start |

> Dates are target windows and can shift based on gate outcomes (quality/security/performance).

---

## 3) Release Readiness Gates

Every planned release requires explicit pass at three gates:

1. **Quality Gate**
   - Full CI green.
   - No unresolved release-critical defects.

2. **Security Gate**
   - Dependency and static checks complete.
   - No unresolved Critical/High vulnerability without approved exception.

3. **Documentation Gate**
   - Release notes, migration notes, and runbook deltas published.
   - Known limitations and rollback instructions updated.

No release moves forward without all gate approvals.

---

## 4) Breaking Changes Policy

### Scope
Applies to CLI commands/flags, API contracts, plugin interfaces, config schema, and persisted data formats.

### Policy Rules
1. Breaking changes are discouraged before v1.0 and strictly controlled after v1.0.
2. Any breaking change proposal must include:
   - technical rationale,
   - migration guide,
   - rollback plan,
   - compatibility test updates.
3. Breaking changes are introduced only in minor/major releases with explicit release-note labeling.
4. Emergency breaks (security-critical) require maintainer approval and immediate communication.

### Communication Standard
- Label: `BREAKING CHANGE` in release notes.
- Include before/after examples and command/API mapping.
- Publish migration checklist and validation commands.

---

## 5) Deprecation Policy

### Standard Deprecation Lifecycle
1. **Announce** (N release): Mark feature as deprecated in docs and runtime warning.
2. **Transition** (N+1 release): Provide migration path and compatibility shim where possible.
3. **Removal** (N+2 release or later): Remove deprecated behavior after grace period.

### Minimum Windows
- Pre-v1: minimum 1 minor release grace period.
- Post-v1: minimum 2 minor releases or 90 days (whichever is longer).

### Required Artifacts
- Deprecation notice in release notes.
- Migration snippet/examples.
- “Last supported version” declaration.

---

## 6) Support Timeline

## Pre-GA (0.x)
- Best-effort support.
- Security fixes prioritized for current minor only.
- Older pre-release versions may be retired quickly.

## GA and After (1.x)
- `latest` minor: full support (features + fixes + security).
- Previous minor: security + critical bug support for 90 days.
- LTS branch begins at `v1.0.0` with backport policy maintained by release managers.

### End-of-Support (EOS)
- EOS dates are published at least one release in advance.
- Final supported patch is documented with upgrade target recommendation.

---

## 7) Milestone Details (Per Release)

## v0.3.0 — Stability & Reliability
**Goal:** Make releases predictable and reduce operational variance.  
**Tasks:** CI hardening, flaky test elimination, release checklist automation.  
**Timeline:** 2026-03-12 to 2026-04-15.  
**Dependencies:** Beta bug backlog triage complete.  
**Risks:** Hidden regressions; environment drift.  
**Success Criteria:** >=98% CI stability; no P0/P1 blockers at cut.

## v0.4.0 — Security Baseline
**Goal:** Achieve audit-ready security posture baseline.  
**Tasks:** threat model refresh, key/secret controls, security regression suite.  
**Timeline:** 2026-04-16 to 2026-05-28.  
**Dependencies:** v0.3 stable pipeline and security policy docs.  
**Risks:** upstream dependency CVEs; perf impact from hardening.  
**Success Criteria:** 0 unresolved Critical/High vulnerabilities.

## v0.5.0 — Performance I
**Goal:** Hit first production SLO targets.  
**Tasks:** retrieval profiling, cache tuning, benchmark standardization.  
**Timeline:** 2026-05-29 to 2026-06-30.  
**Dependencies:** Security baseline closed.  
**Risks:** correctness/perf tradeoffs.  
**Success Criteria:** P95 latency and throughput targets met.

## v0.6.0 — Performance II + Scale
**Goal:** Prove stability at larger data and concurrency levels.  
**Tasks:** index scale optimization, load/stress tests, queue tuning.  
**Timeline:** 2026-07-01 to 2026-08-12.  
**Dependencies:** Bench framework + observability maturity.  
**Risks:** memory growth; architecture bottlenecks.  
**Success Criteria:** scale tests pass with no corruption/data loss.

## v0.7.0 — Enterprise Controls
**Goal:** Add policy, auditability, governance for enterprise adoption.  
**Tasks:** RBAC/policy controls, audit export tooling, config hardening.  
**Timeline:** 2026-08-13 to 2026-09-24.  
**Dependencies:** v0.4-v0.6 hardening/perf completed.  
**Risks:** usability friction from policy complexity.  
**Success Criteria:** enterprise staging validation passed.

## v0.8.0 — Ecosystem Maturity
**Goal:** Stabilize public integration experience.  
**Tasks:** plugin contract tests, API polish, compatibility matrix.  
**Timeline:** 2026-09-25 to 2026-10-29.  
**Dependencies:** stable governance model and contract test infra.  
**Risks:** host environment inconsistency.  
**Success Criteria:** integration matrix green for supported targets.

## v0.9.0 — v1 Readiness
**Goal:** Complete RC cycle and close all GA blockers.  
**Tasks:** freeze breaks, migration docs, rc.1/rc.2 validation.  
**Timeline:** 2026-10-30 to 2026-12-03.  
**Dependencies:** all prior milestone criteria met.  
**Risks:** late blocker discovery and schedule compression.  
**Success Criteria:** Go/No-Go approval for GA cut.

## v1.0.0 — GA
**Goal:** Launch stable, supported, production-ready Memphis release.  
**Tasks:** GA notes, support matrix, LTS branch activation.  
**Timeline:** 2026-12-04 to 2027-01-15.  
**Dependencies:** successful v0.9 RC outcomes.  
**Risks:** early support volume spike.  
**Success Criteria:** 30-day post-GA stability with no critical regressions.
