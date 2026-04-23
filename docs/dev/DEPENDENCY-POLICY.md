# Dependency Policy (Y1 binding)

> **Status.** Binding 2026-04-23 (Q1 N25). Enforced by `.github/workflows/dep-freeze-check.yml`. Every new dependency must be classified in the PR body before merge.

## Why

Memphis is local-first, auditable, sovereign. Every runtime dependency is part of the trust chain: operator trusts Memphis code, Memphis code trusts its deps. Unclassified deps make the chain opaque — a supply-chain compromise in any npm/crates package would propagate without operator visibility.

The policy below makes dep provenance + health explicit per-entry, manual, reviewed. No Dependabot auto-merge.

## Dep classes

Every dependency in `package.json`, `Cargo.toml`, `tools/training/requirements.txt`, or `vendor/` MUST belong to exactly one class:

### `stdlib`

Node stdlib (`fs`, `path`, etc.) or Rust std (`std::fs`, `std::sync`). No external package. Trust = platform.

### `stable-platform`

Actively-maintained upstream on crates.io / npm / PyPI. Pinned version. Bumps require manual PR review (no Dependabot auto-merge). Used for battle-tested core infra.

**Examples:** `fastify`, `tokio`, `serde`, `zod`, `memvid-core` (v2.0 pinned 2026-04), `transformers`, `peft`, `onnxruntime-node`, `modernbert-base` weights.

**Criteria:**
- Apache-2.0 / MIT / BSD-3 / BSD-2 / ISC only (no GPL, no AGPL, no dual/copyleft)
- Last release < 12 months ago OR explicit LTS commitment
- CVE-clean (checked via `npm audit` / `cargo audit`)
- No unmaintained-dep warnings

### `vendored-frozen`

Copied into `vendor/<name>/` with original LICENSE preserved. Pinned SHA. Manual updates only. Reserved for:
- Dormant upstream (no releases > 18 months)
- Hostile upstream (licensing or governance concerns)
- Small enough to own (< 5k LOC typically)

None at Y1 Q1 start. Possible later if e.g. `memvid-core` 2.x breaks semver.

### `scheduled-for-rewrite`

Live dep, Rust/TS rewrite planned. Target quarter logged in `docs/dev/DEPENDENCY-INVENTORY.md` (Q3 N27 deliverable).

None at Q1 start. Populated by Q3 retrospective audit sweep.

### `blocked`

Forbidden class. Includes:
- GPL / AGPL / LGPL / Sleepycat / SSPL / BSL licenses
- Unmaintained > 24 months
- Open critical CVEs
- Upstream governance red flags

PRs introducing a blocked dep fail CI.

## PR workflow

1. Any PR adding / bumping / removing a dep MUST include a `classification:` line in the body per dep. Format:

   ```
   classification:
   - <dep-name> = <class> [: <one-line rationale>]
   ```

   Example:

   ```
   classification:
   - onnxruntime-node = stable-platform: Apache-2.0, in-process, Microsoft maintained
   - bitsandbytes = stable-platform: build-only for training, pinned 0.43.x
   ```

2. `.github/workflows/dep-freeze-check.yml` diffs `package.json`, `Cargo.toml`, `tools/training/requirements.txt`, `vendor/`. If new entries found and `classification:` section missing → CI fails.

3. License compat verified manually during review. `scripts/secret-scan.sh` catches plaintext secrets in new lockfiles; reviewers spot-check licenses.

4. Dependabot config (if any) remains read-only — no auto-merge on dep bumps. Every bump = human PR.

## Audit cadence

- **Per-PR**: classification required (gated by CI).
- **Quarterly**: `docs/security/posture-<year>-Q<n>.md` summary of dep changes.
- **Q3 2026**: full retrospective sweep (N27), produces `docs/dev/DEPENDENCY-INVENTORY.md` — every existing dep classified.
- **Annual**: license audit + CVE scan.

## Exceptions / escape hatches

- A dep temporarily classified `stable-platform` but with open concern (e.g. maintenance slowdown watched) can ship with a `NOTE:` sub-line documenting the watch.
- If upstream breaks between classification and merge → PR re-classified before merge, not merged silently.
- `memvid-core` specifically has dual path: `stable-platform` today (v2.0.x active); if semver breaks → fork to `vendored-frozen` with PR documenting rationale.

## Enforcement summary

| Mechanism | Where | Effect |
|---|---|---|
| PR template checkbox | `.github/pull_request_template.md` | reviewer sees every required check |
| dep-freeze-check CI | `.github/workflows/dep-freeze-check.yml` | hard gate on unclassified new dep |
| License grep | reviewer responsibility | block GPL/AGPL/LGPL before merge |
| Quarterly review | `docs/security/posture-*.md` | posture snapshot incl. dep deltas |
| Q3 inventory | `docs/dev/DEPENDENCY-INVENTORY.md` | single source of truth, refreshed yearly |

## References

- Y1 roadmap: `docs/roadmap/Y1-2026-05-to-2027-05.md` non-negotiable principle #2 ("own the stack with dep class discipline")
- N25 scope: this doc + PR template + dep-freeze CI
- N27 follow-up Q3: full dep inventory
