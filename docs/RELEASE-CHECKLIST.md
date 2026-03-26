# RELEASE CHECKLIST

1. `npm run release:smoke`
2. `npm run ops:rc-drill`
3. Confirm `package.json` version is the intended release version.
4. Review `git status --short` for a clean tree.
5. Confirm the RC drill passed from a fresh temp runtime root, including:
   - bootstrap
   - vault add/get sanity
   - CLI chat and exact-search sanity
   - `memphis tui --check-only --json`
   - HTTP `/health` and `/v1/chat/generate`
   - `mcp serve-once --json`
6. Confirm the package artifact validator passed using a temp-prefix install, not a repo-linked shortcut.
7. If Matrix pilot setup changed, confirm `memphis setup matrix --json` does not emit a fake access token and that vault-backed output matches docs.
8. Tag the release with `vX.Y.Z`.
9. Push the tag to origin.
10. Verify the GitHub Actions release workflow completed.
11. If package-only re-run is needed, trigger `publish-package` from Actions.
12. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
