# Federation Key Exchange — Deferred Design

> **Status**: Deferred — not implemented for pilot (Hotel-Jawor)
> **Reason**: Matrix native auth (TLS + s2s) is sufficient for self-hosted trusted deployments

---

## Threat Model

### Pilot deployment (Hotel-Jawor)
- Self-hosted Synapse on trusted VPS (not public Matrix homeservers)
- Operators control both homeservers
- TLS everywhere
- Matrix authentication between homeservers is trusted

**Assessment**: Matrix native auth covers the threat model. No additional HMAC needed.

### Future: Public Matrix federation
- Traffic crosses unknown Matrix homeservers
- Cannot trust that only authorized agents join the room
- Compliance requirements may mandate application-layer integrity

**Assessment**: HMAC-SHA256 envelope signing becomes necessary.

---

## When to Implement

Implement key exchange when:
1. Memphis federation crosses untrusted Matrix homeservers
2. Compliance requires defense-in-depth beyond transport auth
3. A future audit flags the gap

---

## Proposed Implementation

### Architecture

```
src/federation/keys/
├── federation-key-store.ts   — vault-backed key storage
├── federation-mac.ts         — HMAC-SHA256 on envelopes
└── federation-cli.ts         — CLI commands
```

### Proposed CLI Commands

```bash
# Generate a new federation key for this agent
memphis federation secret-generate

# Output: "Share this secret with your peer via a secure channel:
#          <base64-encoded-secret>
#          Copy and send via Signal/email. Do NOT use plaintext chat."

# Join a federation with a peer using the exchanged secret
memphis federation join --secret <secret> --peer hotel-b

# List configured federation peers
memphis federation peers
```

### Vault Key Storage

Keys stored at:
```
vault/keys/federation.{peerId}.mac_key
```

- Each agent-instance has its own vault (encrypted with local passphrase)
- Secret is provisioned via out-of-band exchange (Signal/email)
- Access requires the local vault passphrase

### Envelope Signing (HMAC-SHA256)

Every `SyncEnvelope` gains a `mac` field:
```
mac = HMAC-SHA256(secret, canonicalJSON(envelope without mac field))
```

On receive:
1. Look up the peer's MAC key from vault
2. Compute HMAC over the envelope (without the `mac` field)
3. Compare in constant-time — if mismatch, drop the envelope
4. On success, process the envelope

### Not Proposed: Pre-shared env var

`MEMPHIS_FEDERATION_SHARED_SECRET` was considered but rejected:
- Plaintext in `.env` — secret leakage via git history, logs, etc.
- No vault integration — inconsistent with Memphis's "secrets as vault values" principle
- Manual distribution burden

---

## Security Properties

| Property | How |
|----------|-----|
| Confidentiality | TLS transport (already in place) |
| Integrity | HMAC-SHA256 over envelope (deferred) |
| Authenticity | Matrix s2s auth + HMAC (deferred) |
| Non-repudiation | HMAC requires possession of shared secret |
| Secret at rest | Vault-encrypted (not env var) |

---

## Implementation Order (when needed)

1. `federation-key-store.ts` — vault read/write for MAC keys
2. `federation-mac.ts` — HMAC-SHA256 sign/verify
3. `SyncEnvelope` type — add `mac?: string` field
4. `MatrixTransport.send()` — attach MAC to outgoing envelopes
5. `MatrixTransport.onMessage()` — verify MAC before processing
6. `federation-cli.ts` — secret-generate, join, peers commands
7. `SyncManager` — integrate MAC verification into incoming envelope path
