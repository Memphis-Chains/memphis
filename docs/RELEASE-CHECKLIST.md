# RELEASE CHECKLIST

1. `npm run release:smoke`
2. Confirm `package.json` version is the intended release version.
3. Review `git status --short` for a clean tree.
4. Tag the release with `vX.Y.Z`.
5. Push the tag to origin.
6. Verify the GitHub Actions release workflow completed.
7. If package-only re-run is needed, trigger `publish-package` from Actions.
8. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
