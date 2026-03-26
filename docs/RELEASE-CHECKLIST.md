# RELEASE CHECKLIST

1. `npm run release:smoke`
2. Confirm `package.json` version is the intended release version.
3. Review `git status --short` for a clean tree.
4. If Matrix pilot setup changed, confirm `memphis setup matrix --json` does not emit a fake access token and that vault-backed output matches docs.
5. Tag the release with `vX.Y.Z`.
6. Push the tag to origin.
7. Verify the GitHub Actions release workflow completed.
8. If package-only re-run is needed, trigger `publish-package` from Actions.
9. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
