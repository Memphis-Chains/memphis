# RFC: Shamir Secret Sharing for Vault Recovery

**Status:** Draft (RFC, not yet implemented)
**Author:** Track C2 — Y2 operational continuity
**Date:** 2026-04-29

## Problem

Memphis is a solo-founder runtime. Today, vault recovery requires:

- Operator passphrase (memorized) **AND**
- Recovery question/answer pair (also memorized)

Bus factor = 1. A single accident, illness, or memory lapse and the chain — years of journal blocks, decisions, case state, vault entries — becomes unreadable. There is no hand-off path to a trusted family member, lawyer, or business successor that doesn't require giving them the live passphrase (which they could then exfiltrate today, not on event of incident).

## Goal

Allow the operator to split vault recovery material into N shares, where any K of N reconstructs the master key. Operator can hand individual shares to trusted parties without any single party being able to unlock the vault alone.

Specifically: **3-of-5 Shamir split**:

| Share | Holder | Purpose |
|---|---|---|
| 1 | Operator (daily) | Daily access. |
| 2 | Trusted person (brother / lawyer / co-founder) | Local human escrow. |
| 3 | Bank safe-deposit box | Offsite physical. |
| 4 | Cloud, encrypted with operator passphrase | Recoverable if 1+2+3 lost together. |
| 5 | Reserve (cold storage) | Disaster fallback. |

**Threshold = 3.** Two shares alone reveal nothing about the secret (information-theoretic security per Shamir 1979).

## Non-Goals

- Multi-party online ceremony. Combine happens on a single trusted host (the recovery operator's machine), not via networked MPC.
- Replace operator passphrase. Shamir is for **recovery**, not daily unlock — the operator still uses passphrase + question/answer day-to-day.
- Cover individual vault entry rotation. Shamir protects the master key, not per-entry peppers.

## Design

### Cryptographic primitive

Use a vetted Rust crate — first choice [`vsss-rs`](https://crates.io/crates/vsss-rs) (verifiable shamir secret sharing) or [`sharks`](https://crates.io/crates/sharks). Avoid hand-rolled finite field arithmetic.

Inputs:
- Master key (32 bytes — the AES-256-GCM key currently derived from passphrase via Argon2id).
- N (number of shares, default 5).
- K (threshold, default 3).

Output: N share blobs. Each share is `[index: u8][bytes: 32]` plus a verifiable commitment (so a tampered share is detectable on combine).

### NAPI surface (new exports in `crates/memphis-vault`)

```rust
#[napi(js_name = "vault_split_shares")]
pub fn vault_split_shares(
  master_key: Buffer,
  share_count: u32,
  threshold: u32,
) -> String  // JSON envelope: { ok, shares: [base64_str; N], commitments: [...] }

#[napi(js_name = "vault_combine_shares")]
pub fn vault_combine_shares(
  shares: Vec<String>,  // base64 strings
) -> String  // JSON envelope: { ok, masterKey?: base64, error? }
```

Both idempotent + failure-tolerant per `docs/dev/SHUTDOWN-LIFECYCLE.md` invariant. Both pure (no I/O); they only operate on inputs.

### CLI surface

```bash
# Setup: split current master key into 3-of-5 shares
memphis vault recovery setup --shares 5 --threshold 3 --out-dir ~/memphis-shares/
# Writes shares as `share-1.json` ... `share-5.json` with metadata (index, threshold, commitment).
# Prints instructions for operator to distribute shares.

# Combine: reconstruct master key from K shares
memphis vault recovery combine --share share-1.json --share share-2.json --share share-3.json
# Prompts for current operator passphrase as authorization.
# On success, replaces vault state with re-encrypted entries using the recovered key.
```

Both commands write `audit` events to the system chain with `signed envelope` so the recovery flow is non-repudiable. Re-running setup with `--rotate` replaces existing shares (old shares no longer reconstruct after rotation).

### Audit + safety

- Every `vault_split_shares` call writes `vault.shamir.split` event to system chain (envelope: shares count, threshold, share fingerprints — NOT share material).
- Every `vault_combine_shares` call writes `vault.shamir.combine` event with provided share fingerprints.
- Combine requires current operator passphrase — defends against an attacker who somehow obtains 3 shares but not the daily passphrase (e.g. operator machine compromise + offline share theft).
- Shares written to disk are never group-readable (`0600` perms enforced).

### Storage

Shares are NOT stored in the vault. They are operator artifacts, distributed to trusted parties via secure offline channels (encrypted USB drive, paper QR code printed for safe-deposit box, etc.). Memphis does NOT track which share went where — that's the operator's threat model decision.

If the operator loses their machine but keeps share #1, they can request shares #2 and #3 from holders, run `memphis vault recovery combine` on a fresh install, and recover.

## Implementation track (separate sprint after RFC approval)

1. Rust crate `crates/memphis-shamir` wrapping `vsss-rs` or `sharks` with a stable JSON envelope API.
2. NAPI exports `vault_split_shares` and `vault_combine_shares` in `crates/memphis-napi`.
3. TS bindings + CLI handlers in `src/infra/cli/handlers/vault.handler.ts` — extend the existing `memphis vault` subcommand.
4. Tests:
   - Round-trip: split → combine with K shares → recovers original key.
   - Tamper detection: corrupt one share, combine fails with clear error.
   - Threshold enforcement: K-1 shares does not reconstruct.
   - Idempotency of NAPI shutdown path (per invariant doc).
5. Docs: `docs/operator/VAULT_RECOVERY.md` operator runbook with share distribution checklist.

## Open questions

- **Share format on disk**: JSON for human-debuggable (operator can `cat share-1.json` to see metadata) vs binary for compactness. RFC default = JSON; revisit if shares get embedded in QR codes (binary saves space).
- **Rotation cadence**: Shares are stable until the operator runs `memphis vault recovery setup --rotate`. Should there be an expiry warning after N years? RFC default = no expiry, surface via `memphis_health` if shares older than 5 years.
- **Sharing thresholds for different vault classes**: Currently one master key for all entries. Future: per-entry-class thresholds (e.g. `chain_keys` 2-of-3 but `business_secrets` 3-of-5)? Out of scope for v1; revisit in Y2+.

## Approval

This RFC is in draft. Approval = Wodzu signs off in PR comment. After approval, file implementation backlog ticket; the actual code change is a separate sprint.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
