# The runtime's own `.env` sat in the published history for eight months — 2026-11-26

**Status:** open
**Severity:** S3 (no live secret was exposed; every value was already rotated, and the published history was rewritten on 2026-11-26)
**Open items:** 4

## Summary

Between 2026-03-10 and 2026-03-15 the repository carried a file named `.env`
at its root. It was committed, it stayed committed through sixteen commits,
and it stayed in the published history of `Memphis-Chains/memphis` for eight
months, until 2026-11-26.

The file was not a template. It held, among its configuration keys, four
non-empty values under `MEMPHIS_VAULT_PEPPER` and one under
`MEMPHIS_API_TOKEN` — two distinct vault peppers (18 and 64 characters) and
one API token (20 characters).

The reason this is an incident and not a tidiness note: the pepper is the
key the vault's encryption is derived from. A pepper that is published is a
pepper that is not secret, and a pepper that is not secret is worth nothing
to the person who holds it. The live pepper has been rotated since, and the
live token does not match the published one, so nothing in the running
system was compromised. But every vault archive encrypted under the OLD
pepper is decryptable by anyone who read this repository, and those archives
exist on this host and in offsite copies.

## Timeline

- **2026-03-10 → 2026-03-15** — eight commits add or modify `.env`
  (measured: 16 commits touch the path in the pre-scrub history, 34 distinct
  blobs across the whole repository, including tags).
- **2026-03 → 2026-11** — the file stays in the published history. Nothing in
  the repository's checks looks at it: the pre-commit hook runs lint, three
  conditional gates and a chain sweep, and none of them asks whether a staged
  path may enter the repository at all.
- **2026-11-22** — the skills catalogue is rewritten and
  `docs/SKILLS.md` records the rule that the repository is the single source
  of truth. The `.env` rule is still only prose, in `AGENTS.md`.
- **2026-11-26, 08:20** — the operator says "scrub".
- **2026-11-26, 08:5x** — measured: 4 non-empty pepper values and 1 token,
  classified without printing a value; the live pepper and the live token do
  not match the published ones.
- **2026-11-26, 09:0x** — a recovery point is taken (a byte copy of `.git`,
  290 MB; a bundle of all 213 refs, 64 MB; a bundle of the five local-only
  branches, 62 MB), then a full mirror of origin is rewritten with
  `git filter-repo --path .env --invert-paths`: 3 927 commits in 1.8 s.
- **2026-11-26, 09:1x** — verification before any push: `.env` in 0 commits,
  `git fsck` exit 0, and for all 69 branches and tags the tree is identical
  to the original minus `.env`, with author, committer, dates and subject
  preserved (400/400 sampled commits), 0 commits pruned.
- **2026-11-26, 19:0x** — 26 branches and 42 tags force-pushed. `main` is
  refused: the ruleset "main" (id 14186283) carries `non_fast_forward` and
  four required status checks, and it has **zero bypass actors** — not even
  the repository admin passes.
- **2026-11-26, 19:1x** — the operator consents to a temporary relaxation.
  The checks are dispatched on the rewritten SHA first, so all four
  contexts are green on the exact commit being pushed; the `non_fast_forward`
  rule and then the `required_status_checks` rule are removed for the push
  itself, because GitHub cannot bind check-runs to a non-fast-forward push.
  The ruleset is restored from its JSON dump immediately afterwards and
  verified byte-identical to the dump. The push took under ten seconds.
- **2026-11-26, 19:2x** — the public fork `elathoxu-crypto/memphis-fork`
  turns out to be outside the operator's reach: neither the operator's token
  nor the PAT in `~/.github-pat` may write to it. Its scrub is prepared and
  verified (66/66 refs) and waits for its owner.

## Impact

**Severity S3**: no live secret was exposed and nothing in the runtime was
compromised. The published history carried two old vault peppers and one old
API token for eight months, to whoever could read the repository.

The residual risk is the archives, not the repository: any vault archive
encrypted under the exposed pepper is decryptable by a reader of the
published history. This host keeps 182 MB nightly archives, and the
offsite backup configuration is part of the same surface.

## Root cause — VERIFIED

The rule existed only as prose. `AGENTS.md` listed `.env` among the paths
that must never be committed, but nothing in the repository ENFORCED it:

- the pre-commit hook (`.githooks/pre-commit`) ran lint, the mutation gate,
  the systemd-unit gate, the chain sweep and the skill-contract gate —
  none of which looks at the path being staged;
- the pre-commit hook was also not a forbidden-path check by itself, so
  "apply the culture by hand" meant exactly that: by hand, every time, by
  whoever happened to be committing.

Two facts make this the interesting class of failure:

1. **The file was committed in March, before the hook existed.** The rule
   that would have caught it was written after the exposure.
2. **The rule has no owner.** A rule that lives in a paragraph of a manifest
   is a rule that waits for the next incident. The rules that survived
   their incidents in this repository — the chain-shape contract, the systemd
   unit policy, the chain allowlist — each have ONE owner module, a corpus
   of cases, and two runners. The `.env` rule had none of that, and it did
   not need all of it: it needed one function and one gate.

## Resolution

**1. The history was rewritten, and verified before it was published.**

`git filter-repo --path .env --invert-paths` in a full mirror of origin.
`.env.example` was deliberately KEPT: it is a template with no values, and
the repository carries it on purpose. The verification is the part that
matters: 69/69 branches and tags have trees identical to the original minus
`.env`, with commit metadata preserved and no commit pruned — the shape of
the history did not change, only the file did.

**2. The recurrence is now impossible by construction.**

`src/infra/audit/forbidden-paths.ts` owns the rule; `scripts/check-forbidden-paths.mts`
is the runner over the staged files; `tests/fixtures/forbidden-path-cases.json`
(15 cases) and `tests/unit/forbidden-paths.test.ts` (21 tests) pin it; the
pre-commit hook runs it on every staged change. The gate reads PATHS only,
so it can never print a secret into a log.

Falsifier: staging a `.env` fails the gate with exit 1; staging
`.env.example` passes; `dist/`, `node_modules/`, `vault-state.json`,
`*.tier2-passphrase` and `.github-pat` are refused by name.

**3. The four commit references in the documentation were repointed** at
their rewritten counterparts. The remaining eleven references are not
Memphis commits at all — a commit in `MiniMax-AI/minimax-code` and a GGUF
model hash — and were left alone.

## Anti-confab — what we are NOT claiming

- **We are not claiming the vault was breached.** The live pepper was
  rotated before this document was written; the published value does not
  match the live one. There is no evidence of a decryption.
- **We are not claiming the fork is scrubbed.** It is not. Its history is
  public and still carries the old file; the rewrite is prepared and waiting
  for write access we do not have.
- **We are not claiming the PR refs are clean.** Six `.env` blobs remain
  reachable through `refs/pull/*`, which GitHub owns and no client may
  push or delete.
- **We are not claiming the local repository is clean.** Five branches and
  two detached worktrees still point into the old history, because their
  work was never ported.
- **We did not rotate anything today.** The pepper and the token were
  already rotated when the file was found; this document reports a rotation
  that had already happened, not one performed by the response.

## Lessons learned — action items

1. **A forbidden-path rule needs an owner, a corpus and a runner.** Not a
   paragraph. This repository already knows how to do that; the `.env` rule
   was the one rule that never got the treatment.
2. **The rewrite is the expensive half of the answer.** The gate is the
   cheap half: it costs a file that never enters, instead of a force-push of
   every branch and tag with the branch protection relaxed for a window.
   Both halves are now in place; the gate is the one that prevents the next
   incident.
3. **GitHub's `non_fast_forward` rule has no admin bypass.** A history
   rewrite is not a normal push; it needs the operator's consent, the
   checks dispatched on the rewritten SHA, and the ruleset restored
   byte-for-byte afterwards. The dump is the receipt.
4. **A public fork is a separate blast radius.** The fork was not on the
   operator's radar as a published copy of the history, and no token on this
   host can write to it.

## Open items

- [ ] **Scrub the public fork** `elathoxu-crypto/memphis-fork`. The rewrite
      is prepared and verified at
      `/home/memphis/runtime-archives/scrub-2026-11-26/fork-mirror.git`
      (66/66 refs verified). It needs write access this host does not have:
      the owner of that repository has to run it, or has to delete the fork.
- [ ] **Decide about the six `.env` blobs still reachable through
      `refs/pull/*`** on origin. GitHub owns those refs; the only lever is
      deleting the affected pull requests, which destroys their discussion.
- [ ] **Decide about the five local branches and two detached worktrees that
      still point into the old history** (`backup/main-tmp-689`,
      `chore/priorities-2026-11-03`, `docs/mobile-project-roadmap-20261120`,
      `preserve/corpus-contract-pre-rebase-3f62c0ab`,
      `preserve/local-priorities-2026-10-27-1b466153`, and the worktrees at
      `runtime-archives/kartograf-followup-2026-10-26/deploy-candidate` and
      `runtime-archives/mobile-project-roadmap-20261120`). Their content is
      preserved in `local-only-commits.bundle`.
- [ ] **Answer whether any vault archive was encrypted under the exposed
      pepper.** The archives on this host, and the offsite copies, are the
      residual risk this incident actually leaves. If any archive predates
      the rotation, it should be re-keyed or destroyed.

## Related

- `docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md` — the
  other incident whose rule also had to grow an owner, a corpus and a gate.
- `src/infra/audit/forbidden-paths.ts` — the rule this incident produced.
- `docs/design/MEMPHIS-ERROR-LEDGER.md` — the ledger of what is still open.
- Decisions #603 (the scrub) and #604 (the 65-commit branch measured and not
  merged), journal #1108.
