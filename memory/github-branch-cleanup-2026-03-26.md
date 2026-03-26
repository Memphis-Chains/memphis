# GitHub Branch Cleanup Inventory — 2026-03-26

Verified against `main` on 2026-03-26.

Goal:

- salvage only concrete ideas still missing from `main`,
- do not merge stale long-lived branches wholesale,
- close/delete stale branches once their remaining value is documented.

Execution status:

- cleanup executed on 2026-03-26,
- all listed non-`main` remote branches were deleted from `origin`,
- no branch was merged wholesale.

## Decisions

| Branch | Divergence vs `main` | Decision | Rationale |
| --- | --- | --- | --- |
| `origin/feat/soul-system-phase-a` | `142 0` | deleted | no unique commits remained; `main` fully superseded it |
| `origin/release/0.3.1` | `174 0` | deleted | pure historical release branch; no unique work remained |
| `origin/core/bridge-correctness` | `156 1` | deleted without salvage | current `main` already covers the bridge-compat/fallback test intent across chain, embed, and vault adapters |
| `origin/fix/vault-masterkey` | `196 4` | deleted without salvage | `main` already supports both `master_key` and `masterKey` and covers the current edge cases |
| `origin/feat/rust-chain-activation` | `196 3` | deleted | the unique ideas around Rust-chain activation and proposal routes were already present on `main` |
| `origin/feat/consolidate-memphisos` | `199 2` | deleted | historical rename/consolidation branch; no active product value left beyond audit history |
| `origin/feat/memory-routes` | `203 14` | deleted after salvage review | branch was massively divergent from hardened `main`; no commit justified a direct merge or cherry-pick |

`git rev-list --left-right --count main...<branch>` is recorded as `main_unique branch_unique`.

## Salvage Review Notes

### `origin/feat/memory-routes`

Reviewed unique commits:

- `a8add0f` `feat(http): add /api/recall and /api/journal memory routes`
- `ceec904` `fix(journal): index entries in embed store so recall returns results`
- `94cdf8f` `fix(chain): align TypeScript hash computation with Rust canonical format`
- `e7495ab` `feat(cognitive): expand model-d governance and proactive assistant`

Status against current `main`:

- memory routes are already live and hardened,
- journal writes already index semantic recall,
- chain hashing alignment is already landed,
- Model D and proactive assistant have since been substantially refactored and hardened,
- `ModelD.saveKey()` is now intentionally fail-closed instead of persisting private key material,
- durable writes now normalize onto the supported Rust block contract.

Decision:

- do not cherry-pick `e7495ab`,
- do not merge `origin/feat/memory-routes`,
- only re-open this branch if a future targeted diff review finds one specific behavior still absent from `main`.

### `origin/fix/vault-masterkey`

Unique commits:

- `94b2d77` `fix(vault): add masterKey camelCase for NAPI bridge`
- `99c29e3` `feat(http): agent communication routes and test exec hardening`
- `78a2d3f` `feat(rust-core): activate Rust chain backend with canonical hash computation`
- `93aae91` `refactor: signer allowlist, centralized config, error logging, bridge utilities`

Status against current `main`:

- `master_key` and `masterKey` normalization is already present,
- Rust-chain activation and the hardened proposal route already exist on `main`,
- no reason remains to merge this branch as a unit.

Decision:

- keep only as short-lived reference while finishing `v1.0.0`,
- close/delete once the current bridge/vault test surface remains green after release-candidate shakeout.

### `origin/core/bridge-correctness`

Unique commit:

- `6538cc9` `test(bridge): cover napi compatibility and fallback paths`

Decision:

- current `main` already has equivalent or stronger coverage for:
  - chain adapter camelCase compatibility,
  - embed adapter camelCase compatibility and tuned-search fallback,
  - vault adapter missing-bridge and legacy-shape handling,
- no salvage was required,
- branch deleted.

## Cleanup Order

Cleanup result:

1. Zero-unique and historical branches were deleted.
2. Reference-only branches were rechecked against current tests and deleted.
3. `origin/main` is the only remaining active remote branch.

## Rule Going Forward

- stale branches are not parallel roadmaps,
- salvage concrete ideas onto current `main`,
- then delete the stale branch instead of leaving it as pseudo-active work.
