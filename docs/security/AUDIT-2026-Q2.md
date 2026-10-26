# Q2 internal security review — 2026-10-26

Review type: internal code review by the coding agent. External review: pending.
This document does not satisfy roadmap N15. Scope: TypeScript identity recovery,
reflection persistence, memory rotation, MV2 transfer and quarterly acceptance.
This is not a penetration test or independent certification of Rust cryptography.

| Finding                                                                                                     | Disposition / evidence                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing public DID could cause normal initialization to replace an existing vault seed                      | PR #692 refuses reinitialization when seed metadata exists; bounded recovery derives the original public DID. Host recovery preserved vault state/entries metadata; doctor reported zero required failures.                            |
| Reflection returned before its memory-action append completed; that append omitted the supplied environment | PR #692 awaits persistence and captures environment paths. A deterministic delayed-writer regression failed before the fix.                                                                                                            |
| Vault archival failure wrote an extra plaintext memory archive and cleared active memory                    | This change postpones rotation and retains active entries. A regression verifies unchanged active bytes, no plaintext archive, no secret in the warning, and a successful later vault retry.                                           |
| Old MV2 omitted hashes/signatures and lacked a trusted snapshot restore                                     | Separate MV2 work preserves full JSON, signs a manifest, requires an expected DID, validates hashes/signatures/continuity, and stages a fresh restore. Vault, embedding and privileged soul restoration remain outside generic import. |
| Quarterly acceptance counted any nonempty audit file                                                        | This change requires completed external-review evidence bound to the report SHA-256. An internal report cannot pass. Evidence is an operator-reviewed attestation, not proof of reviewer identity.                                     |

`npm audit --omit=dev --json` initially reported five affected packages: four
moderate, one low, zero high/critical. Scoped compatible lockfile updates fixed
those production findings: express-rate-limit 8.3.2 → 8.7.1, fast-uri 3.1.8 →
3.1.9, fastify 5.12.5 → 5.12.7, hono 4.13.9 → 4.13.14, ip-address 10.7.2 →
10.7.5. The production audit now reports zero vulnerabilities. No package ranges
changed. The complete graph still reports four moderate development findings;
this is not a claim that every dependency is audit-clean. The private operator
archive retains initial and remediated machine-readable results. Compatibility
is checked by the required PR tests against a fresh install.

An actual independent external review remains required; no third party was
contacted. MV2 snapshots are signed, not encrypted, and require private storage.
Restore assumes an operator-controlled parent; its lock serializes cooperating
importers, not arbitrary same-UID writers. Legacy block-hash compatibility is
retained. The snapshot signature covers full payloads, including fields omitted
by older block canonicalization; historical blocks were not rehashed. The active
memory file's existing plaintext format is unchanged by the archive fix.
Unrelated endpoints, all dependencies, model quality and historical “all tracks”
roadmap promises are not certified here.

Future external-review acceptance requires
`docs/security/AUDIT-2026-Q2.evidence.json` containing `reviewType: "external"`,
`status: "completed"`, nonempty `reviewer`, past `completedAt`, an HTTPS `source`
referring to the review, and `reportSha256` of this report. Do not create that
attestation for this internal review. Tests use synthetic evidence only.
