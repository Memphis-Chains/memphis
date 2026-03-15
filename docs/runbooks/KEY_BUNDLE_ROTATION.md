# Key Bundle Rotation

Use this runbook to rotate detached incident-signing keys while preserving trust-root-signed provenance.

## 1. Inputs

- current trust root manifest (`trust_root.json`)
- active trust root private signing key
- existing detached public-key bundle (optional for first issuance)
- new signing key id for the rotated key entry

## 2. Rotate Bundle + Generate Fresh Signing Keypair

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

Key-source alternatives:

- `--trust-root-signing-key-pem`
- `--trust-root-signing-key-pem-base64`
- env vars: `MEMPHIS_TRUST_ROOT_SIGNING_KEY_PATH`, `MEMPHIS_TRUST_ROOT_SIGNING_KEY_PEM`, `MEMPHIS_TRUST_ROOT_SIGNING_KEY_PEM_BASE64`

Defaults:

- `--bundle-out`: `data/public-key-bundle.json`
- `--base-bundle-path`: `--bundle-out` if file already exists
- `--new-key-id`: `incident-key-<timestamp>`

## 3. Validate Rotated Bundle Before Incident Use

```bash
npm run -s ops:verify-incident-manifest -- \
  --manifest-path data/incident-bundle.manifest.json \
  --public-key-bundle-path data/public-key-bundle.json \
  --trust-root-path config/trust_root.json \
  --expected-key-id incident-key-v2 \
  --require-signature \
  --require-key-bundle-signature
```

Expected results:

- `checks.keyBundleSignatureValid=true`
- `checks.keyBundleTrustRootMatch=true`
- `checks.keyIdMatch=true` for the new key id

## 4. Operational Notes

- Rotation fails closed when the trust-root signer is not in `trust_root.json.rootIds`.
- New private signing keys are emitted separately; store them in a secure key manager and do not commit them.
- Keep prior key entries in the bundle until all in-flight incident workflows have migrated.
