# Security Policy

## Supported versions

For the v1.0.0 production line:

- ✅ `1.x` — supported
- ⚠️ pre-1.0 tags (`0.x`, alpha/rc builds) — best effort, no guarantee

## Responsible disclosure

Please report vulnerabilities privately. Do **not** open public issues for exploitable security findings.

When reporting, include:

1. Affected version/commit
2. Reproduction steps
3. Impact assessment
4. Suggested mitigation (if known)

## Security contact

- GitHub Security Advisories (preferred):
  `https://github.com/Memphis-Chains/memphis-v5/security/advisories`
- Fallback issue channel (for non-sensitive security hardening questions):
  `https://github.com/Memphis-Chains/memphis-v5/issues`

## Security features

Memphis v5 includes:

- **Local-first storage model** (reduced third-party data exposure)
- **Secret hygiene policy** (`.env` / external secret stores, no secrets in git)
- **Input validation boundaries** (schema-first validation paths)
- **Auth policy controls** for protected API/gateway routes
- **Rate limiting / abuse guardrails** on sensitive endpoints
- **Operational smoke gates** for release confidence

## Encryption details

Cryptographic tracks used in the project architecture:

- **Argon2id** for password/key derivation hardening
- **AES-256-GCM** for authenticated encryption in vault-oriented paths
- **Ed25519** for signing/verification paths used by closure/proof workflows
- **SHA-256 chaining** for integrity-linked memory/ledger primitives

> Exact active surfaces can vary by deployment profile and enabled runtime flags.

## Audit status

- Internal security baseline and hardening docs are maintained in-repo.
- Security smoke scripts are included and expected in release gates.
- At v1.0.0, **no independent third-party formal audit is claimed** unless explicitly published by maintainers.

## Security update policy

- Critical vulnerabilities: patch release as soon as validated.
- High severity: prioritized in nearest release window.
- Lower severity hardening: scheduled via normal roadmap and release cycle.
