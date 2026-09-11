# ADR-003 — Versioning Model

Date: 2026-07-15
Status: Accepted

## Context

Memphis has had inconsistent public versioning signals:

- Source code: `package.json.version = 1.12.0`, tags `v1.9.0` through `v1.12.0`
- Public site `memphis-v5.pl`: branding as "Memphis v5"
- `agents.json`: name = "Memphis v5"
- `CHANGELOG.md`: documents v1.9.0 → v1.12.0

The "v5" prefix originated from an internal codename in `MEMPHIS-V5-STRATEGIC-REPORT-2026-03-11.md` for the HTTP API rewrite ("v5 = HTTP API server for OpenClaw integration"). The codename leaked into the domain name and external manifests but never entered the actual version stream.

The result: domain suggests v5, agents.json says v5, source code is v1.12.0. Anyone visiting the site, fetching agents.json, or comparing to git tags gets a confusing mismatch.

## Decision

1. **Source-code version is authoritative.** `package.json.version` and git tags are the single source of truth.
2. **Major versions are integer bumps.** v1.x → v2.0 when breaking changes land. No "v5" codename survives in shipping artifacts.
3. **Internal codenames stay internal.** Future redesigns may use a codename (e.g. "v6-HW-bindings") but must not appear in any domain, manifest, or public file.
4. **Public surface references current runtime version.** `memphis-v5.pl` agents.json `name` field changes to `"Memphis"` (drops the version) OR `"Memphis v1.12.x"` (mirrors runtime). Domain itself may stay (marketing/SEO cost) but a banner clarifies the relationship.
5. **Git tags use `vX.Y.Z` format.** Codenames are forbidden in tag names.

## Consequences

### Plusy

- One source of truth (`package.json.version`)
- No ambiguity for consumers, contributors, or grant reviewers
- License detection on GitHub works (standard Apache-2.0 LICENSE file)
- Honesty Legend from `docs/roadmap/HONESTY-LEGEND.md` is now satisfied for software version claims

### Minusy

- Domain `memphis-v5.pl` is now misleading. Acceptable cost: marketing visibility of the existing domain outweighs the cost of renaming.
- Existing external links pointing to "v5" in docs will need to be reconciled. Acceptable: low volume, internal-only audience.

## Implementation

- [x] LICENSE rewritten to standard Apache-2.0 header (LICENSE)
- [x] Custom authors extracted to AUTHORS.md
- [ ] `memphis-v5.pl/agents.json` `name` field updated to drop "v5" (operator action — outside this repo)
- [ ] Add `version_disclaimer` to `memphis-v5.pl` index page explaining the naming mismatch
- [ ] Future PRs to changelog cross-reference this ADR

## Coda

This ADR is a small file about a small inconsistency. The fact that it exists at all is a sign of craftsmanship: the runtime is mature enough to fix its own public-facing narrative. The fact that it took 4.5 months to surface is also a sign: priorities were on producing code, not maintaining public-facing metadata. Both are reasonable trade-offs for a solo project.
