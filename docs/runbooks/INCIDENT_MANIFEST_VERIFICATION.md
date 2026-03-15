# Incident Manifest Verification

Use this runbook to produce and verify incident evidence bundles before handoff to security/compliance or external responders.

## 1. Inputs

- incident timeframe and scope
- signing private key (file path or env-injected PEM)
- corresponding public key for verification
- signer key id (recommended)

## 2. Export Bundle + Manifest

```bash
npm run -s ops:export-incident-bundle -- \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --signing-key-path /secure/path/incident-signing-key.pem \
  --signing-key-id incident-key-v1
```

Optional cognitive-summary integrity metadata in manifest:

```bash
npm run -s ops:export-incident-bundle -- \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --include-cognitive-summaries \
  --cognitive-report-limit 10
```

When enabled, manifest includes `cognitiveReports.included/count/digestSha256` and verifier checks bundle payload integrity against those values.

Alternative key sources:

- `--signing-key-pem`
- `--signing-key-pem-base64`
- env vars: `MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM` / `MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM_BASE64`

Optional encrypted-at-rest companions for transfer:

```bash
npm run -s ops:export-incident-bundle -- \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --encryption-passphrase "$MEMPHIS_INCIDENT_TRANSFER_PASSPHRASE"
```

Policy enforcement for financial workflows:

```bash
MEMPHIS_QUEUE_MODE=financial \
MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS=true \
npm run -s ops:export-incident-bundle -- \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --encryption-passphrase "$MEMPHIS_INCIDENT_TRANSFER_PASSPHRASE"
```

Profile presets:

```bash
# Export profile: financial strict defaults
npm run -s ops:export-incident-bundle -- \
  --profile financial-strict \
  --out data/incident-bundle.json \
  --encryption-passphrase "$MEMPHIS_INCIDENT_TRANSFER_PASSPHRASE"

# Export profile: forensics-lite defaults (encryption optional)
npm run -s ops:export-incident-bundle -- \
  --profile forensics-lite \
  --out data/incident-bundle.json

# Export profile: strict handoff defaults (manifest + cognitive summaries)
npm run -s ops:export-incident-bundle -- \
  --profile strict-handoff \
  --out data/incident-bundle.json
```

One-command strict handoff (export + strict verify + pass/fail summary):

```bash
npm run -s ops:strict-incident-handoff -- \
  --status-url http://127.0.0.1:8080/v1/ops/status \
  --audit-path data/security-audit.jsonl \
  --out data/incident-bundle.json \
  --manifest-out data/incident-bundle.manifest.json \
  --signing-key-path /secure/path/incident-signing-key.pem \
  --signing-key-id incident-key-v2 \
  --public-key-bundle-path data/public-key-bundle.json \
  --trust-root-path config/trust_root.json
```

Use `--json` for automation-friendly stage/check output.

Shell completion and env contract hints:

```bash
npm run -s ops:strict-incident-handoff -- --completion-hints
```

Readiness-only strict preflight (no export/verify side effects):

```bash
npm run -s ops:strict-incident-handoff -- \
  --preflight-only \
  --signing-key-path /secure/path/incident-signing-key.pem \
  --signing-key-id incident-key-v2 \
  --public-key-bundle-path data/public-key-bundle.json \
  --trust-root-path config/trust_root.json
```

Common env defaults used by strict handoff:

- `MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PATH` / `_PEM` / `_PEM_BASE64`
- `MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID`
- `MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH`
- `MEMPHIS_TRUST_ROOT_PATH`

## 3. Verify Evidence Integrity

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-path /secure/path/incident-signing-public.pem \
  --expected-key-id incident-key-v1 \
  --require-signature
```

Focused check for cognitive-summary integrity fields:

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --skip-chain-event \
  | jq '{ok, cognitive: {countMatch: .checks.cognitiveSummaryCountMatch, digestMatch: .checks.cognitiveSummaryDigestMatch}}'
```

Strict cognitive-summary requirement mode:

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --require-cognitive-summaries
```

Env toggle equivalent:

```bash
MEMPHIS_INCIDENT_REQUIRE_COGNITIVE_SUMMARIES=true \
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json
```

Detached key bundle mode:

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-bundle-path data/public-key-bundle.json \
  --expected-key-id incident-key-v1 \
  --require-signature
```

Rotate detached key bundles (before switching signer ids):

```bash
npm run -s ops:rotate-key-bundle -- \
  --trust-root-path config/trust_root.json \
  --trust-root-signing-key-path /secure/path/trust-root-signer.pem \
  --base-bundle-path data/public-key-bundle.json \
  --bundle-out data/public-key-bundle.json \
  --new-key-id incident-key-v2 \
  --new-private-key-out /secure/path/incident-key-v2.pem \
  --new-public-key-out data/incident-key-v2.pub.pem
```

Strict provenance mode (recommended for production handoffs):

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-bundle-path data/public-key-bundle.json \
  --trust-root-path config/trust_root.json \
  --expected-key-id incident-key-v1 \
  --require-signature \
  --require-key-bundle-signature
```

Verify profile presets:

```bash
# Strict trust-root handoff mode
npm run -s ops:verify-incident-manifest -- \
  --profile trust-root-strict \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-bundle-path data/public-key-bundle.json \
  --expected-key-id incident-key-v2

# Legacy compatibility mode (no strict signature/provenance enforcement)
npm run -s ops:verify-incident-manifest -- \
  --profile legacy-compat \
  --manifest-path data/incident-bundle.manifest.json
```

`trust-root-strict` now also enforces cognitive-summary requirement checks (`requireCognitiveSummaries=true`).

Strict chain-link mode with retry/backoff:

```bash
MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED=true \
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-path /secure/path/incident-signing-public.pem \
  --expected-key-id incident-key-v1 \
  --require-signature \
  --chain-event-retry-count 2 \
  --chain-event-retry-backoff-ms 50
```

Bundle schema:

```json
{
  "schemaVersion": 1,
  "keys": [{ "keyId": "incident-key-v1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----..." }],
  "provenance": {
    "algorithm": "ed25519",
    "signerRootId": "sha256(publicKeyPem)",
    "signerPublicKeyPem": "-----BEGIN PUBLIC KEY-----...",
    "payloadSha256": "sha256(JSON.stringify({schemaVersion,keys}))",
    "signature": "base64(ed25519-sign(payload))"
  }
}
```

Encrypted manifest/bundle verification mode:

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json.enc \
  --decryption-passphrase "$MEMPHIS_INCIDENT_TRANSFER_PASSPHRASE" \
  --public-key-path /secure/path/incident-signing-public.pem \
  --expected-key-id incident-key-v1 \
  --require-signature
```

Verification must report:

- `ok=true`
- `checks.bundleHashMatch=true`
- `checks.bundleSizeMatch=true`
- `checks.cognitiveSummaryCountMatch=true` and `checks.cognitiveSummaryDigestMatch=true` when manifest `cognitiveReports.included=true`
- `checks.cognitiveSummaryMetadataPresent=true` and `checks.cognitiveSummaryRequirementSatisfied=true` when strict cognitive mode is enabled
- `checks.signatureVerified=true`
- `checks.keyFingerprintMatch=true`
- `checks.keyIdMatch=true` (when expected key id is set)
- `checks.keyBundleSignatureValid=true` and `checks.keyBundleTrustRootMatch=true` when strict detached-bundle provenance is enabled
- `checks.manifestEncrypted=true` and `checks.bundleEncrypted=true` when encrypted companions are used
- `chainEvent.written=true` (immutable `incident_manifest.verification` linkage)

## 4. Strict-Handoff JSON Contract

Operator tooling should consume strict-handoff JSON outputs using the stable contract fixtures:

- summary/completion contract: `tests/fixtures/strict-handoff/output-contract.json`
- formal JSON Schemas:
  - summary output: `tests/fixtures/strict-handoff/summary.schema.json`
  - completion hints output: `tests/fixtures/strict-handoff/completion-hints.schema.json`
- validator summary contract: `tests/fixtures/strict-handoff/validator-output-contract.json`
- failure stage contracts:
  - `tests/fixtures/strict-handoff/failure-preflight.json`
  - `tests/fixtures/strict-handoff/failure-export.json`
  - `tests/fixtures/strict-handoff/failure-verify.json`

Validator JSON contract versioning policy:

- `schemaVersion` in `validator-output-contract.json` increments only for breaking changes.
- Additive fields/check IDs are allowed within the same `schemaVersion`; automation should ignore unknown keys.
- Existing keys (`schemaVersion`, `ok`, `checks`, `error`, `errors`) plus existing check IDs/order must remain stable for the current schema version.
- Breaking changes must update: contract fixture, validator script, regression tests, and this runbook section in the same PR.

Stable summary top-level keys:

- `schemaVersion`
- `ok`
- `stage` (`preflight|export|verify`)
- `profiles`
- `artifacts`
- `checks`
- `error`
- `errors`

Use `ops:strict-incident-handoff --json` for machine ingestion and treat unknown keys as additive, not breaking.

Example `jq` parser (strict contract + minimal triage payload):

```bash
npm run -s ops:strict-incident-handoff -- \
  --out data/incident-bundle.json \
  --signing-key-path /secure/path/incident-signing-private.pem \
  --signing-key-id incident-key-v1 \
  --public-key-bundle-path /secure/path/public-key-bundle.json \
  --trust-root-path /secure/path/trust_root.json \
  --json \
| jq -e '
  .schemaVersion == 1 and
  (.stage as $stage | ["preflight", "export", "verify"] | index($stage) != null) and
  (.ok | type == "boolean")
' \
| jq '{
  ok,
  stage,
  bundlePath: .artifacts.bundlePath,
  manifestPath: .artifacts.manifestPath,
  chainEventWritten: .checks.chainEventWritten,
  chainEventIndex: .checks.chainEventIndex,
  chainEventHash: .checks.chainEventHash,
  error,
  errors
}'
```

Example TypeScript parser (fixture-aligned key guards):

```ts
type StrictHandoffStage = 'preflight' | 'export' | 'verify';

type StrictHandoffSummary = {
  schemaVersion: number;
  ok: boolean;
  stage: StrictHandoffStage;
  profiles: { export: string; verify: string };
  artifacts: { bundlePath: string | null; manifestPath: string | null };
  checks: {
    signatureVerified: boolean | null;
    keyBundleSignatureValid: boolean | null;
    keyBundleTrustRootMatch: boolean | null;
    cognitiveSummaryRequirementSatisfied: boolean | null;
    chainEventWritten: boolean | null;
    chainEventIndex: number | null;
    chainEventHash: string | null;
  };
  error: string | null;
  errors: string[];
};

const REQUIRED_TOP_LEVEL_KEYS = [
  'schemaVersion',
  'ok',
  'stage',
  'profiles',
  'artifacts',
  'checks',
  'error',
  'errors',
] as const;

export function parseStrictHandoffSummary(rawJson: string): StrictHandoffSummary {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in parsed)) throw new Error(`strict-handoff summary missing key: ${key}`);
  }
  if (parsed.schemaVersion !== 1) throw new Error('unsupported strict-handoff schemaVersion');
  if (parsed.stage !== 'preflight' && parsed.stage !== 'export' && parsed.stage !== 'verify') {
    throw new Error('invalid strict-handoff stage');
  }
  return parsed as StrictHandoffSummary;
}
```

Example `jq` parser for completion hints (`--completion-hints` contract):

```bash
npm run -s ops:strict-incident-handoff -- --completion-hints \
| jq -e '
  .schemaVersion == 1 and
  .command == "ops:strict-incident-handoff" and
  (.requiredFlags | index("--public-key-bundle-path") != null) and
  (.policyEnvVars | index("MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH") != null)
' \
| jq '{
  command,
  profiles,
  requiredFlags,
  requiredSigningKeyFlags,
  optionalValueFlags,
  optionalBooleanFlags,
  policyEnvVars
}'
```

Example TypeScript parser for completion hints:

```ts
type StrictHandoffCompletionHints = {
  schemaVersion: number;
  command: 'ops:strict-incident-handoff';
  profiles: { export: string; verify: string };
  requiredFlags: string[];
  requiredSigningKeyFlags: string[];
  optionalValueFlags: string[];
  optionalBooleanFlags: string[];
  policyEnvVars: string[];
};

const REQUIRED_COMPLETION_HINT_KEYS = [
  'schemaVersion',
  'command',
  'profiles',
  'requiredFlags',
  'requiredSigningKeyFlags',
  'optionalValueFlags',
  'optionalBooleanFlags',
  'policyEnvVars',
] as const;

export function parseStrictHandoffCompletionHints(rawJson: string): StrictHandoffCompletionHints {
  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  for (const key of REQUIRED_COMPLETION_HINT_KEYS) {
    if (!(key in parsed)) throw new Error(`strict-handoff completion hints missing key: ${key}`);
  }
  if (parsed.schemaVersion !== 1) throw new Error('unsupported completion-hints schemaVersion');
  if (parsed.command !== 'ops:strict-incident-handoff') {
    throw new Error('unexpected completion-hints command value');
  }
  return parsed as StrictHandoffCompletionHints;
}
```

Ajv CLI validation examples (end-to-end schema checks):

```bash
# One-command validator (fixtures + live command output).
npm run -s ops:validate-strict-handoff-fixtures

# Machine-readable validator summary.
npm run -s ops:validate-strict-handoff-fixtures -- --json \
  | jq '{ok, checks, error, errors}'

# Validate example fixture payloads against schema contracts.
npx -y ajv-cli validate \
  --spec=draft2020 \
  -s tests/fixtures/strict-handoff/summary.schema.json \
  -d tests/fixtures/strict-handoff/summary-example-preflight.json

npx -y ajv-cli validate \
  --spec=draft2020 \
  -s tests/fixtures/strict-handoff/completion-hints.schema.json \
  -d tests/fixtures/strict-handoff/completion-hints-example.json

# Validate live command outputs.
npm run -s ops:strict-incident-handoff -- --json > /tmp/strict-handoff-summary.json || true
npx -y ajv-cli validate \
  --spec=draft2020 \
  -s tests/fixtures/strict-handoff/summary.schema.json \
  -d /tmp/strict-handoff-summary.json

npm run -s ops:strict-incident-handoff -- --completion-hints > /tmp/strict-handoff-completion-hints.json
npx -y ajv-cli validate \
  --spec=draft2020 \
  -s tests/fixtures/strict-handoff/completion-hints.schema.json \
  -d /tmp/strict-handoff-completion-hints.json
```

TypeScript Ajv example (schema validation in service code):

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

const repoRoot = process.cwd();
const summarySchema = JSON.parse(
  readFileSync(path.join(repoRoot, 'tests/fixtures/strict-handoff/summary.schema.json'), 'utf8'),
);
const completionSchema = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'tests/fixtures/strict-handoff/completion-hints.schema.json'),
    'utf8',
  ),
);
const summaryPayload = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'tests/fixtures/strict-handoff/summary-example-preflight.json'),
    'utf8',
  ),
);
const completionPayload = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'tests/fixtures/strict-handoff/completion-hints-example.json'),
    'utf8',
  ),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSummary = ajv.compile(summarySchema);
const validateCompletion = ajv.compile(completionSchema);

if (!validateSummary(summaryPayload)) {
  throw new Error(`summary validation failed: ${ajv.errorsText(validateSummary.errors)}`);
}
if (!validateCompletion(completionPayload)) {
  throw new Error(
    `completion-hints validation failed: ${ajv.errorsText(validateCompletion.errors)}`,
  );
}
```

Validator troubleshooting (`ops:validate-strict-handoff-fixtures`):

| Failure Signal                                                            | Failure Class                | Typical Cause                                                                    | Operator Action                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `[FAIL] summary example fixture matches summary schema`                   | Fixture-schema drift         | `summary-example-preflight.json` no longer satisfies `summary.schema.json`       | Regenerate/update the summary example fixture from current strict-handoff output and confirm `summaryTopLevelKeys` contract alignment. |
| `[FAIL] completion-hints example fixture matches completion-hints schema` | Fixture-schema drift         | `completion-hints-example.json` missing/renamed fields expected by schema        | Refresh completion-hints example fixture from `ops:strict-incident-handoff --completion-hints` and re-run validator.                   |
| `[FAIL] completion-hints command output matches completion-hints schema`  | Runtime-output/schema drift  | command output key or value semantics changed without schema update              | Compare live output with `completion-hints.schema.json`; update schema + fixtures + contract tests together or revert output change.   |
| `[FAIL] summary command output matches summary schema`                    | Runtime-output/schema drift  | strict-handoff `--json` output shape changed, or non-JSON noise leaked to stdout | Ensure machine JSON remains stdout-only, update schema/contracts intentionally, and rerun `test:ops-artifacts`.                        |
| `invalid JSON output`                                                     | Output channel contamination | additional logs or warnings printed to stdout in command scripts                 | Move diagnostic logs to stderr and keep stdout strictly JSON for machine-mode commands.                                                |

When troubleshooting, treat schema files, output-contract fixtures, and command output as one contract surface; update them in a single PR.

## 5. Handoff Package

Attach these artifacts to incident records:

- `incident-bundle.json`
- `incident-bundle.manifest.json`
- optional encrypted companions: `incident-bundle.json.enc`, `incident-bundle.manifest.json.enc`
- verifier JSON output (`ok=true` proof)
- system chain event reference (`chainEvent.index` + `chainEvent.hash`)
- command transcript and timestamp of execution

Do not attach private signing keys.

## 6. Failure Handling

Use this strict-handoff triage matrix when `ops:strict-incident-handoff` reports `[FAIL]`.

| Stage       | Failure Class                               | Typical Signal                                                                        | Operator Action                                                                                                                                                          |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preflight` | Missing signer/key-bundle/trust-root inputs | `strict handoff preflight failed`                                                     | Provide `--signing-key-*`, `--signing-key-id` (or `--expected-key-id`), `--public-key-bundle-path`, `--trust-root-path`; rerun with `--json` to confirm resolved checks. |
| `preflight` | Trust root manifest unavailable             | `trust root manifest not found`                                                       | Confirm `MEMPHIS_TRUST_ROOT_PATH` or `--trust-root-path`; restore expected `trust_root.json` before retry.                                                               |
| `export`    | Encryption policy input gap                 | `encrypted artifacts are required by policy`                                          | Provide one encryption passphrase source (`--encryption-passphrase`, `--encryption-passphrase-base64`, `--encryption-passphrase-file`, or env).                          |
| `verify`    | Bundle integrity mismatch                   | `bundle sha256 mismatch` or `bundle byte size mismatch`                               | Treat artifact as tampered/corrupted; regenerate bundle + manifest and rerun verification.                                                                               |
| `verify`    | Signature/key identity failure              | `signature verification failed` or `signature key id mismatch`                        | Validate signing key ownership, expected key id, and detached key bundle contents; rotate keys if compromise suspected.                                                  |
| `verify`    | Detached key-bundle provenance failure      | `public key bundle signature verification failed` or trust-root mismatch              | Rebuild/sign detached key bundle via `ops:rotate-key-bundle`, then verify with current trusted root manifest.                                                            |
| `verify`    | Cognitive evidence requirement failure      | `cognitive summary metadata is required` or `bundle missing cognitiveReports payload` | Re-export with strict profile (`--profile strict-handoff`) and ensure cognitive summaries are embedded.                                                                  |
| `verify`    | Chain-link append enforcement failure       | `failed to append incident verification chain event`                                  | Restore chain write path, rerun verification, and confirm `chainEvent.written=true`.                                                                                     |

If strict-handoff still fails after remediation, escalate with attached artifacts (`bundle`, `manifest`, strict-handoff JSON output, and chain event status fields).

## 7. Closure Criteria

Incident evidence is ready for closure only when:

1. manifest verification passes with `ok=true`
2. signer identity (`keyId`) is validated against incident ownership records
3. bundle + manifest are archived according to retention policy
