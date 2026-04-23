<!--
Memphis PR template (2026-04-23, N25).
Keep sections concise. Delete sections that genuinely don't apply.
-->

## Summary

<!-- 1-3 bullet points: what changed, why. -->

## Test plan

<!-- Markdown checklist. Include specific test files where relevant. -->

- [ ]
- [ ]

## Security / scope checks

- [ ] Threat surface unchanged (or: threat delta described above)
- [ ] No new secret storage / retrieval path (or: described + vault-backed)
- [ ] `scripts/secret-scan.sh` clean (or: exception documented with justification)
- [ ] No arbitrary code execution added to `.claude/settings*.json` allowlist

## Dependency classification (required if PR adds/bumps/removes any dep)

<!--
Per docs/dev/DEPENDENCY-POLICY.md. Classes: stdlib, stable-platform,
vendored-frozen, scheduled-for-rewrite, blocked. License must be Apache-
compatible (no GPL/AGPL/LGPL/SSPL). Bumps also require classification.

classification:
- <dep-name> = <class>: <one-line rationale>
-->

## Backwards compat

- [ ] No breaking change (or: migration path documented)
- [ ] Chain / block schema unchanged (or: schema migration documented)
- [ ] CLI surface unchanged (or: `type(scope)` commit header reflects the new surface)

## Roadmap tie-in

<!-- Optional: N-item this closes from docs/roadmap/Y1-2026-05-to-2027-05.md -->
