# RELEASE CHECKLIST

## Release candidate

1. `npm run release:smoke`
2. `npm run ops:rc-drill:fresh-env`
3. `npm run -s ops:release-preflight -- --json`
4. Confirm `package.json` version matches the intended RC version.
5. Review tracked changes before prep; unrelated untracked notes must not affect the candidate.
6. Confirm the RC drill passed from a clean temp runtime root and clean shell env, including:
   - bootstrap
   - vault add/get sanity
   - semantic recall and exact-search sanity
   - CLI chat sanity
   - `memphis tui --check-only --json`
   - `memphis tui --run-command "/config tools list" --json`
   - manual interactive TUI cancel drill via `docs/runbooks/TUI_CANCEL_DRILL.md`
   - HTTP `/health` and `/v1/chat/generate`
   - `mcp serve-once --json`
7. Confirm the package artifact validator passed using a temp-prefix install, not a repo-linked shortcut.
8. If Matrix pilot setup changed, confirm the optional trusted-pilot check still passes:
   `memphis setup matrix --json` must not emit a fake access token and vault-backed output must match docs.
9. Run `./scripts/prepare-release-candidate.sh --version <semver-prerelease>`.
10. Push `main`.
11. Dispatch `.github/workflows/release-draft-dispatch.yml` with matching `version=<semver-prerelease>`.
12. Verify the draft release contains:
   - the package tarball
   - `.sha256`
   - `validator-metadata.json`
   - `validator-metadata.json.sha256`

## Final GA after RC signoff

13. Update to the final GA version with `./scripts/release.sh --version <semver>` or an appropriate bump.
14. Confirm the final GA/hotfix path ran the same shared release contract as RC:
    - `npm run release:smoke`
    - `npm run -s ops:release-preflight -- --json`
15. Tag the release with `vX.Y.Z`.
16. Push the tag to origin.
17. Verify the GitHub Actions release workflow completed.
18. If package-only re-run is needed, trigger `publish-package` from Actions.
19. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
