# Release process

Memphis tags `v*` to fire `.github/workflows/release.yml`, which:

1. runs the shared release gates (`scripts/run-release-gates.sh`),
2. packs the npm tarball (`prepack` rebuilds the NAPI bridge in
   release mode — see S9-0 / PR #390),
3. emits a `SHA256SUMS` file and, if signing is configured,
   detached `.asc` GPG signatures next to the tarball,
4. creates the GitHub Release and attaches the tarball + sums + sigs,
5. publishes to GitHub Packages npm registry.

This doc covers (3) — how to set up GPG signing for the release
artifacts. Without it, releases ship unsigned but with valid
`SHA256SUMS` (operators can still verify integrity, just not
provenance).

## Quick state check

| Status | What you'll see |
|--------|-----------------|
| Signing **enabled** | Each `v*` release page includes `*.tgz`, `SHA256SUMS`, and matching `.asc` files. |
| Signing **disabled** | Each release page includes `*.tgz` and `SHA256SUMS` only. The CI log shows a `::notice ::GPG_PRIVATE_KEY secret not set` line. |

The workflow gracefully degrades — missing secrets do not fail the
release. You can flip signing on at any tag without touching the
workflow itself.

## Setup (one-time)

### 1. Pick a key strategy

Two valid options:

- **Reuse an existing operator GPG key** (e.g. the same key the
  maintainer uses for git commit signing). Lower trust-root count but
  ties release identity to a personal key.
- **Generate a dedicated `memphis-release@memphis-chains.org` key.**
  Cleaner separation; recommended if release mechanics may move
  between maintainers.

This doc covers option 2 because the steps are explicit; reusing an
existing key is the same minus the "generate" step.

### 2. Generate the dedicated release key

On a workstation (not in CI):

```bash
gpg --batch --gen-key <<EOF
Key-Type: RSA
Key-Length: 4096
Subkey-Type: RSA
Subkey-Length: 4096
Name-Real: Memphis Release
Name-Email: memphis-release@memphis-chains.org
Expire-Date: 2y
Passphrase: <pick a strong passphrase>
%commit
EOF
```

Verify:

```bash
gpg --list-secret-keys --keyid-format=long memphis-release@memphis-chains.org
```

Note the long key ID (e.g. `0x4AEE18F83AFDEB23`).

### 3. Export the private key for CI

```bash
gpg --armor --export-secret-keys memphis-release@memphis-chains.org > /tmp/memphis-release-private.asc
# Verify it starts with -----BEGIN PGP PRIVATE KEY BLOCK-----
head -1 /tmp/memphis-release-private.asc
```

### 4. Upload to GitHub repo secrets

Settings → Secrets and variables → Actions → New repository secret:

- **`GPG_PRIVATE_KEY`** — paste the entire `/tmp/memphis-release-private.asc`
  contents (including the BEGIN/END markers).
- **`GPG_PASSPHRASE`** — the passphrase you set during key generation.

Then **destroy the local export**:

```bash
shred -u /tmp/memphis-release-private.asc
```

The exported file is no longer needed once it's in GH Secrets, and
leaving it on disk extends the blast radius of a workstation
compromise.

### 5. Publish the public key

So operators can verify a signed release:

- Push to a public keyserver:
  ```bash
  gpg --send-keys --keyserver hkps://keys.openpgp.org <KEY_ID>
  ```
- Optionally publish to the repo as `keys/memphis-release.pub.asc`:
  ```bash
  gpg --armor --export memphis-release@memphis-chains.org > keys/memphis-release.pub.asc
  git add keys/memphis-release.pub.asc && git commit -m "docs(keys): publish memphis-release public key"
  ```
- Document the fingerprint in `README.md` under a "Verifying
  releases" section so operators know which key to trust.

### 6. Test on a pre-release tag

```bash
git tag v1.8.0-rc.0
git push origin v1.8.0-rc.0
```

Watch the run. The workflow should now show:

- `::notice ::GPG signing enabled — release artifacts will ship with detached .asc signatures.`
- `Sign tarball + SHA256SUMS` step running.
- The release page lists `memphis-chains-memphis-1.8.0-rc.0.tgz`,
  `SHA256SUMS`, `memphis-chains-memphis-1.8.0-rc.0.tgz.asc`,
  `SHA256SUMS.asc`.

If the release page only has the tarball + SHA256SUMS, the GPG step
was skipped — open the run log and search for `GPG_PRIVATE_KEY secret
not set`.

## Operator-side verification

Operators downloading a release verify in two steps:

```bash
# 1. Checksum
sha256sum -c SHA256SUMS

# 2. Signature (requires the public key imported)
gpg --verify SHA256SUMS.asc SHA256SUMS
gpg --verify memphis-chains-memphis-1.8.0.tgz.asc memphis-chains-memphis-1.8.0.tgz
```

A clean `gpg --verify` returns `Good signature from "Memphis Release
<memphis-release@memphis-chains.org>"` plus a fingerprint trust line.
Anything else (`BAD`, `NO_PUBKEY`, expired key) means do not install.

To import the public key on a fresh box:

```bash
gpg --keyserver hkps://keys.openpgp.org --recv-keys <FINGERPRINT>
# or
curl -fsSL https://github.com/Memphis-Chains/memphis/raw/main/keys/memphis-release.pub.asc | gpg --import
```

## Key rotation

The 2-year expiry on the key generated in step 2 forces a periodic
rotation. To rotate:

1. Generate a new key (step 2) — append a year suffix to disambiguate
   if the old one is still on keyservers
   (`memphis-release-2028@memphis-chains.org`).
2. Sign the new public key with the old one to chain trust:
   ```bash
   gpg --sign-key <NEW_KEY_ID>
   ```
3. Update the repo secrets (step 4) with the new private key.
4. Publish the new public key (step 5) and announce in the release
   notes for the rotation cut.
5. Revoke the old key on keyservers (`gpg --gen-revoke` then send to
   keyserver) once a grace window has passed.

## Why no Sigstore / cosign

Sigstore (keyless OIDC-based signing via GitHub Actions) is a valid
alternative to GPG and would remove the secrets-management overhead.
Memphis chose GPG for v1.8.0 because:

- The npm distribution layer (`npm install`) is the primary attack
  surface, and GPG-signed tarballs match the long-standing UNIX
  packaging conventions operators already understand.
- Sigstore requires the verifier to fetch transparency log entries
  from rekor.sigstore.dev, an external dependency that conflicts
  with the offline-installable spirit of Memphis.
- Reusing the same key for the npm publish step (S9-5) keeps the
  trust root down to one (the GH Secrets-stored private key).

If Sigstore becomes interesting in a future release, the workflow
can ship both — GPG signatures stay where they are; cosign attestations
get added in a parallel step and operators choose which they trust.

## Related

- `.github/workflows/release.yml` — the workflow itself
- `.github/workflows/publish-package.yml` — manual GH Packages
  republish (uses `GITHUB_TOKEN`, not the GPG key)
- `docs/operator/CLEAN-INSTALL.md` — operator-side install + verify
  walkthrough (will get a `Verify the release signature` block when
  signing is live)
- `scripts/run-release-gates.sh` — pre-release gates run before the
  artifact build
