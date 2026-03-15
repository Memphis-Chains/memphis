# Startup Guard Incident Triage

Use this runbook when startup guard checks fail or `/v1/ops/status` reports degraded startup security state.

## 1. Capture Current Status

```bash
curl -s http://127.0.0.1:8080/v1/ops/status | jq '.startup'
```

Focus on:

- `startup.trustRoot`
- `startup.revocationCache`
- `startup.safeModeNetwork`

## 2. Field-To-Action Mapping

### `startup.trustRoot`

- `enabled=true`, `valid=false`
  Action: verify `MEMPHIS_TRUST_ROOT_PATH` exists and schema is valid (`version > 0`, non-empty unique `rootIds`).

- `enabled=true`, `valid=true`
  Action: no trust-root startup action required.

- `reason` contains `missing`
  Action: restore trust root manifest from known-good source; do not disable strict mode in production as a first response.

### `startup.revocationCache`

- `enabled=true`, `stale=true`
  Action: refresh revocation cache source and set `MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS` to current epoch ms from trusted updater.

- `enabled=true`, `stale=false`
  Action: cache freshness is acceptable.

- `ageMs > maxStaleMs`
  Action: investigate scheduler/worker responsible for cache sync; treat high-risk routes as intentionally blocked.

### `startup.safeModeNetwork`

- `enabled=true`, `mode=degraded`, `enforced=false`
  Action: confirm required privileges for network enforcement (for iptables backend) or keep safe mode with no-spawn policy until fixed.

- `enabled=true`, `mode=enforced`, `enforced=true`
  Action: safe-mode network posture is active.

- `enabled=false`, `mode=disabled`
  Action: normal for non-safe-mode boot.

## 3. Exit Code Correlation

- `101` `ERR_HARDENING`: hardening primitive failed in strict mode.
- `102` `ERR_CORRUPTION`: chain/snapshot corruption path.
- `103` `ERR_TRUST_ROOT`: trust-root validation failed in strict mode.

If process exits with `103`, expect `startup.trustRoot.valid=false` in drill/test paths and fix trust-root inputs before restart.

## 4. Fast Verification Commands

```bash
npm run -s ops:drill-guards
npm run -s test:ts -- tests/integration/ops-status.e2e.test.ts
npm run -s ops:export-incident-bundle -- --out data/incident-bundle.json
npm run -s ops:export-incident-bundle -- \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --signing-key-path /secure/path/incident-signing-key.pem \
  --signing-key-id incident-key-v1
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-path /secure/path/incident-signing-public.pem \
  --expected-key-id incident-key-v1 \
  --require-signature
```

Both commands must pass before closing incident.

Exporter behavior:

- redaction is enabled by default (`[REDACTED]` marker); use `--no-redact` only for isolated local debugging
- retention pruning defaults to `--retention-count 20` and `--retention-days 14`
- retention can be tuned with `MEMPHIS_INCIDENT_BUNDLE_RETENTION_COUNT` and `MEMPHIS_INCIDENT_BUNDLE_RETENTION_DAYS`
- signed manifest output is optional and intended for forensic chain-of-custody records
- signing key source can come from file path or env-injected PEM (`MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM` / `_BASE64`)
- include `--signing-key-id` and verify with `--expected-key-id` to bind evidence to signer identity
- for off-host transfer, emit encrypted companions with `--encryption-passphrase` and verify via `--manifest-path ...enc` + `--decryption-passphrase`
- set `MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS=true` for financial workflows to fail closed when encryption is missing
- optionally embed latest cognitive journal summaries with `--include-cognitive-summaries` (tune via `--cognitive-report-limit` / `MEMPHIS_INCIDENT_COGNITIVE_REPORT_LIMIT`)
- `--profile strict-handoff` enables manifest output + cognitive summary embedding by default for strict verifier handoffs
- override the journal source for incident handoff with `--cognitive-journal-path` / `MEMPHIS_INCIDENT_COGNITIVE_JOURNAL_PATH`
- manifest now carries cognitive-summary integrity metadata (`cognitiveReports.count` + `cognitiveReports.digestSha256`) and verifier enforces it via `checks.cognitiveSummary*`
- enable strict cognitive evidence enforcement with `--require-cognitive-summaries` (or `MEMPHIS_INCIDENT_REQUIRE_COGNITIVE_SUMMARIES=true`)
- keep chain linkage enabled (default) and confirm `chainEvent.written=true` in verifier output
- tune chain append resilience with `--chain-event-retry-count` + `--chain-event-retry-backoff-ms` (or matching env vars)
- when using detached key bundles, enforce provenance with `--require-key-bundle-signature --trust-root-path <path>`
- if direct public-key files are unavailable, verify via `--public-key-bundle-path` key registry (`schemaVersion:1`)
- run manifest verification before incident closure to confirm bundle integrity and signature validity

## 5. Combined Failure Escalation

Treat this as high severity when both conditions are present:

- `startup.safeModeNetwork.mode = degraded`
- `startup.revocationCache.stale = true`

Escalation thresholds:

- Longer than 5 minutes in combined state:
  Action: page on-call operator and freeze high-risk workflow submissions.

- Longer than 15 minutes in combined state:
  Action: declare incident, keep safe mode active, and block financial/admin mutation paths until recovery is verified.
