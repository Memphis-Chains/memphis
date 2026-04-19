# RELEASE CHECKLIST

## Release candidate

1. `npm run release:smoke`
2. Confirm `npm run -s test:rust` passed inside the shared release gate, and rerun it explicitly if the Rust workspace or local toolchain path changed.
3. `npm run ops:rc-drill:fresh-env`
4. `npm run -s ops:release-preflight -- --json`
5. Confirm `package.json` version matches the intended RC version.
6. Review tracked changes before prep; unrelated untracked notes must not affect the candidate.
7. Confirm the RC drill passed from a clean temp runtime root and clean shell env, including:
   - bootstrap
   - vault add/get sanity
   - semantic recall and exact-search sanity
   - CLI chat sanity
   - `memphis tui --check-only --json`
   - `memphis tui --run-command "/config tools list" --json`
   - manual interactive TUI cancel drill via `docs/runbooks/TUI_CANCEL_DRILL.md`
   - HTTP `/health` and `/v1/chat/generate`
   - `mcp serve-once --json`
8. Review `memphis init status --json` and confirm the runtime reports an explicit first-run plan or explicit legacy migration/manual-recovery state.
9. Review `memphis config surfaces list --json` and confirm chat surfaces such as Telegram/Discord remain fail-closed unless the candidate deliberately raises them.
10. Review `memphis health --json` and confirm `surfacePolicies`, `scheduler`, and runtime repair state match the `init status` truth.
11. Confirm the GA convergence smoke still covers aliased Telegram/local conversation continuity.
12. If actor aliasing or conversation repair changed, verify the candidate documentation still matches runtime normalization semantics.
13. Confirm the package artifact validator passed using a temp-prefix install, not a repo-linked shortcut.
14. If Matrix pilot setup changed, confirm the optional trusted-pilot check still passes:
    `memphis setup matrix --json` must not emit a fake access token and vault-backed output must match docs.
15. Run `./scripts/prepare-release-candidate.sh --version <semver-prerelease>`.
16. Push `main`.
17. Dispatch `.github/workflows/release-draft-dispatch.yml` with matching `version=<semver-prerelease>`.
18. Verify the draft release contains:

- the package tarball
- `.sha256`
- `validator-metadata.json`
- `validator-metadata.json.sha256`

## Final GA after RC signoff

19. Update to the final GA version with `./scripts/release.sh --version <semver>` or an appropriate bump.
20. Confirm the final GA/hotfix path ran the same shared release contract as RC:
    - `npm run release:smoke`
    - `npm run -s test:rust`
    - `npm run -s ops:release-preflight -- --json`
21. Tag the release with `vX.Y.Z`.
22. Push the tag to origin.
23. Verify the GitHub Actions release workflow completed.
24. If package-only re-run is needed, trigger `publish-package` from Actions.
25. Confirm the published package name is `@memphis-chains/memphis` and the binary is `memphis`.
