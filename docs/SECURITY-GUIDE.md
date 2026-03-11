# Memphis v5 Security Guide

## 1) Cryptography Details

## Key derivation
- Algorithm: **Argon2id** (`memphis-vault/src/keyring.rs`)
- Params:
  - memory: `65536`
  - iterations: `3`
  - parallelism: `4`
  - output length: `32` bytes
- Salt: 32-byte random salt

## Data encryption
- Algorithm: **AES-256-GCM** (`memphis-vault/src/crypto.rs`)
- Nonce: 12-byte random nonce per encryption
- Output: ciphertext + nonce (IV)

## 2FA mechanism (recovery Q&A)
- Q&A answer normalized (trim + lowercase), hashed with SHA-256
- Vault key derived from `master_key XOR qa_hash_bytes`
- Security model: passphrase + knowledge factor

## DID identity
- Ed25519 keypair generation (`ed25519-dalek`)
- DID format: `did:memphis:<encoded-public-key>`
- DID/private key bootstrap tied to vault init flow

---

## 2) Authentication Mechanisms

## HTTP bearer token
- env: `MEMPHIS_API_TOKEN`
- header: `Authorization: Bearer <token>`
- route-level policy in `src/infra/http/auth-policy.ts`

## Gateway exec auth
- `/exec` uses dedicated auth enforcement + policy checks
- dev-only local bypass possible with dangerous flag and loopback IP

## DID and identity usage
- DID is generated and returned on vault init
- used for sync/trade identity semantics

---

## 3) Security Best Practices

1. Always set strong `MEMPHIS_API_TOKEN` in production.
2. Set long random `MEMPHIS_VAULT_PEPPER` (min 12 chars, recommended 32+).
3. Keep `RUST_CHAIN_ENABLED=true` only with validated bridge build.
4. Bind services to localhost unless externally required.
5. Place Memphis behind reverse proxy/TLS for remote access.
6. Rotate API tokens and vault recovery answers periodically.
7. Restrict filesystem permissions for `~/.memphis`.
8. Monitor `security-audit.jsonl` continuously.
9. Disable dangerous exec mode in production.
10. Use backups with checksum verification before maintenance.

---

## 4) Audit Log Interpretation

Default path:
- `data/security-audit.jsonl` (overridable via `MEMPHIS_SECURITY_AUDIT_LOG_PATH`)

Each line is JSON:
```json
{
  "ts": "2026-03-11T11:22:33.000Z",
  "action": "gateway.exec.attempt",
  "status": "blocked",
  "ip": "10.0.0.5",
  "route": "/exec",
  "details": { "message": "unauthorized" }
}
```

Common actions:
- `gateway.exec.auth`
- `gateway.exec.attempt`
- `journal.append`

Status values:
- `allowed`
- `blocked`
- `error`

What to alert on:
- repeated blocked auth attempts from same IP
- bursts of exec errors
- invalid journal chain name attempts

---

## 5) Key Rotation Procedures

## API token rotation
1. Generate new token.
2. Deploy new `MEMPHIS_API_TOKEN` to service env.
3. Restart Memphis service.
4. Update clients.
5. Revoke old token.

## Vault passphrase / recovery rotation (practical sequence)
1. Export/backup current secrets (encrypted state + verified backups).
2. Re-initialize vault with new passphrase + Q&A.
3. Re-encrypt required entries.
4. Validate decrypt path for all critical keys.
5. Securely retire old recovery material.

## Pepper rotation
- Requires controlled re-encryption/re-initialization flow.
- Perform only during maintenance window with tested rollback backup.

---

## 6) Incident Response Checklist

## Detection
- [ ] alert fired (auth failures / integrity failures / abnormal errors)
- [ ] identify affected endpoint(s), host(s), timeframe

## Containment
- [ ] rotate API token if compromise suspected
- [ ] disable/lock `/exec` path if abuse detected
- [ ] isolate exposed host/network path

## Eradication
- [ ] remove malicious configs/scripts
- [ ] patch vulnerable dependency or config
- [ ] verify filesystem and env integrity

## Recovery
- [ ] restore from known-good backup if needed
- [ ] run health + doctor checks
- [ ] verify vault decrypt, provider health, and session flows

## Post-incident
- [ ] collect logs/audit evidence
- [ ] timeline + root cause analysis
- [ ] document corrective actions
- [ ] add regression checks/alerts
