# RELEASE CHECKLIST

1. `npm run release:smoke`
2. Confirm `package.json` version is the intended release version.
3. Review `git status --short` for a clean tree.
4. Confirm the source-checkout bootstrap smoke passed and still reflects the canonical GA operator path.
5. Confirm the package artifact validator passed using a temp-prefix install, not a repo-linked shortcut.
6. If Matrix pilot setup changed, confirm `memphis setup matrix --json` does not emit a fake access token and that vault-backed output matches docs.
7. Tag the release with `vX.Y.Z`.
8. Push the tag to origin.
9. Verify the GitHub Actions release workflow completed.
10. If package-only re-run is needed, trigger `publish-package` from Actions.
11. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
