# Memphis v5 Roadmap

**Project:** Memphis v5  
**Current stable planning baseline:** `v0.2.0-beta.1` (public beta)  
**Document owner:** Core maintainers / production coordination  
**Last updated:** 2026-03-11

---

## 1) Current Status (v0.2.0-beta.1)

Memphis v5 is in public beta with core runtime foundations in place:

- Memory runtime, retrieval, and CLI/API paths are operational.
- Public beta documentation and installation flow exist.
- Security hardening has started (P0 pass), but external audit-grade closure is pending.
- Multi-agent sync is available as MVP and needs protocol hardening + enterprise controls.

### Immediate Program Priorities

1. Move from **feature-complete beta** to **reliability-grade release train**.
2. Reduce operational risk through security audit and performance SLO enforcement.
3. Prepare governance, compatibility, and support policies required for v1.0.0.

---

## 2) Versioning Strategy

Memphis uses **Semantic Versioning (SemVer)**:

- `MAJOR` = breaking API/CLI behavior changes.
- `MINOR` = backward-compatible features.
- `PATCH` = backward-compatible bug/security fixes.
- Pre-release tags: `-alpha.N`, `-beta.N`, `-rc.N`.

### Compatibility Rules

- No intentional breaking changes in `0.x` without migration notes.
- `1.0.0` establishes compatibility contract for CLI, API, plugin interfaces.
- Every breaking proposal must include:
  - migration plan,
  - deprecation window,
  - rollback procedure.

---

## 3) Release Cadence

- **Minor release target:** every 6-8 weeks.
- **Patch releases:** on demand (security/critical stability).
- **Release Candidates (RC):** 1-2 weeks before each major maturity gate.
- **LTS designation starts at:** `v1.0.0`.

Governance checkpoints before each minor release:

1. Test gate pass (unit/integration/smoke).
2. Security gate pass (SCA + policy checks).
3. Docs gate pass (release notes, migration, runbook updates).

---

## 4) Milestones and Timeline

## M1 — v0.3.0 (Stability & Release Reliability)

**Timeline:** 2026-03-12 → 2026-04-15 (target release: **2026-04-15**)

**Goal**  
Transition from feature-beta to predictable release reliability.

**Tasks**

- Harden CI gates (build/test/lint/security baseline).
- Close known beta regressions and flaky tests.
- Finalize install + quickstart consistency across docs.
- Introduce release readiness checklist automation.

**Dependencies**

- Clean test baseline from v0.2.0-beta.1.
- Maintainer bandwidth for CI and packaging work.

**Risks**

- Hidden flaky tests prolonging stabilization.
- Toolchain drift across environments.

**Success Criteria**

- > = 98% pass rate on main branch CI over rolling 14 days.
- No P0/P1 open defects at release cut.
- Reproducible install on Linux/macOS/WSL from documented steps.

---

## M2 — v0.4.0 (Security Hardening Baseline)

**Timeline:** 2026-04-16 → 2026-05-28 (target release: **2026-05-28**)

**Goal**  
Complete pre-audit hardening and reduce high-risk attack surface.

**Tasks**

- Threat-model refresh (runtime, plugin, sync channels).
- Secret handling and key-rotation workflow tightening.
- Dependency vulnerability budget + remediation SLA.
- Security regression suite integrated in CI.

**Dependencies**

- v0.3.0 stable CI/release pipeline.
- Security policy and disclosure process in repo.

**Risks**

- New vulnerabilities in upstream dependencies.
- Security fixes impacting performance paths.

**Success Criteria**

- 0 known Critical/High vulnerabilities at release time.
- Security test suite mandatory and green in CI.
- Published security hardening report and operator guidance.

---

## M3 — v0.5.0 (Performance Optimization I)

**Timeline:** 2026-05-29 → 2026-06-30 (target release: **2026-06-30**)

**Goal**  
Reach production-grade latency and memory baselines for common workloads.

**Tasks**

- Profiling and hotspot elimination in retrieval pipeline.
- Cache policy tuning (TTL/LRU), cold/warm behavior validation.
- Benchmark harness standardization and historical tracking.

**Dependencies**

- Stable security baseline from v0.4.0.
- Benchmark corpus and repeatable performance environment.

**Risks**

- Over-optimization causing correctness regressions.
- Hardware variance hiding performance regressions.

**Success Criteria**

- P95 query latency within defined SLO targets.
- No performance regression >10% across core benchmark set.
- Performance report published with reproducible methodology.

---

## M4 — v0.6.0 (Performance Optimization II + Scale)

**Timeline:** 2026-07-01 → 2026-08-12 (target release: **2026-08-12**)

**Goal**  
Improve scale behavior for larger repositories and multi-session usage.

**Tasks**

- Optimize index/update paths for larger datasets.
- Improve concurrency controls and queue handling.
- Introduce load/stress test suite with failure-mode coverage.

**Dependencies**

- v0.5.0 benchmark framework.
- Observability metrics and tracing hooks.

**Risks**

- Throughput improvements increasing memory footprint.
- Stress behavior exposing architectural constraints.

**Success Criteria**

- Stable operation at target scale envelope.
- Stress tests pass with no data-loss/corruption outcomes.
- Documented scaling guidance for operators.

---

## M5 — v0.7.0 (Enterprise Controls)

**Timeline:** 2026-08-13 → 2026-09-24 (target release: **2026-09-24**)

**Goal**  
Introduce enterprise-ready governance and operational controls.

**Tasks**

- RBAC/policy controls for high-sensitivity actions.
- Audit trail completeness and export tooling.
- Config profile hardening for production environments.

**Dependencies**

- Security hardening + observability maturity.
- Backward-compatible config migration tooling.

**Risks**

- Added complexity reducing usability.
- Policy edge cases causing operational friction.

**Success Criteria**

- Enterprise control set validated in staging.
- Audit logs meet internal traceability requirements.
- No breaking impact on standard user flows.

---

## M6 — v0.8.0 (Ecosystem & Integration Maturity)

**Timeline:** 2026-09-25 → 2026-10-29 (target release: **2026-10-29**)

**Goal**  
Harden external integrations and ecosystem developer experience.

**Tasks**

- Plugin contract stabilization and compatibility tests.
- API quality improvements (errors, docs, examples).
- Integration certification checklist for supported environments.

**Dependencies**

- Stable enterprise policy model (v0.7.0).
- Contract test suite across plugin/runtime boundaries.

**Risks**

- Integration variability across host environments.
- API contract drift from rapidly evolving features.

**Success Criteria**

- Integration test matrix green for supported targets.
- Developer docs completion for all public interfaces.
- Reduced support incidents tied to integration setup.

---

## M7 — v0.9.0 (v1 Readiness / RC Program)

**Timeline:** 2026-10-30 → 2026-12-03 (target release: **2026-12-03**)

**Goal**  
Run formal readiness process for v1.0.0 with release candidate cycles.

**Tasks**

- Freeze breaking-scope proposals.
- Complete migration guides and compatibility docs.
- Execute RC cycle (`rc.1`, `rc.2` as needed).
- Resolve all release blockers from audit/performance/enterprise tracks.

**Dependencies**

- Completion of v0.3-v0.8 milestone commitments.
- User feedback from beta and ecosystem adopters.

**Risks**

- Last-minute blocker discovery in RC phase.
- Scope creep delaying stable release.

**Success Criteria**

- 0 unresolved release-critical issues.
- RC telemetry and feedback indicate stable behavior.
- Go/No-Go committee approves 1.0 release cut.

---

## M8 — v1.0.0 (General Availability)

**Timeline:** 2026-12-04 → 2027-01-15 (target release: **2027-01-15**)

**Goal**  
Ship first GA release with support commitments and operational maturity.

**Tasks**

- Publish GA release notes and support matrix.
- Launch LTS branch and backport policy.
- Finalize operator runbooks, SLOs, incident procedures.

**Dependencies**

- Successful v0.9.0 readiness gate.
- Final audit + performance signoff.

**Risks**

- Release pressure reducing quality margin.
- Post-GA support load spike.

**Success Criteria**

- GA shipped with signed artifacts and complete docs.
- LTS policy active and communicated.
- 30-day post-GA stability window with no critical regressions.

---

## 5) Long-Term Vision (v1.0.0+)

### v1.1-v1.3 (2027 H1)

- Advanced orchestration features and policy automation.
- Extended integration SDKs and ecosystem certification.
- Reliability automation for self-healing operational flows.

### v2.0 Direction (2027+)

- Multi-tenant architecture options.
- Enterprise governance packs and compliance reporting.
- Distributed memory topologies with stronger federation controls.

---

## 6) Program-Level Risks and Mitigation

1. **Security/compliance lag**  
   Mitigation: front-load audit work (v0.4-v0.7), enforce vulnerability SLAs.

2. **Performance regression due to feature growth**  
   Mitigation: mandatory benchmark gates in every release train.

3. **Integration fragmentation**  
   Mitigation: compatibility matrix + contract tests + certification checklist.

4. **Roadmap over-commitment**  
   Mitigation: strict scope control and explicit deferrals each milestone.

---

## 7) Governance and Review Rhythm

- **Weekly:** milestone progress + risk review.
- **Bi-weekly:** dependency and blocker review.
- **Per release:** formal Go/No-Go gate with evidence links.
- **Quarterly:** roadmap recalibration based on user adoption and telemetry.
