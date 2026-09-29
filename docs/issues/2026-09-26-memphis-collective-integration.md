## memphis-collective integration proposal — for maintainer PR with attribution

> **Author:** @Memphis-Chains (Wodzu / Marcin Kukla, Poland)
> **Repo of proposed work:** https://github.com/Memphis-Chains/minimax-code
> **Branch / commit:** `c32c23f` (rebased on your current `main`)
> **Category:** extension proposal, optional plugin-like addition

## TL;DR

We've written a small extension package — `@mavis/memphis-collective` — and pushed it to a public fork. It is MIT-licensed, rebased on your current main, has 16/16 tests passing, and slots into your existing architecture **without modifying any of your files in-place except the package-additions required to register a new extension**. The diff is 22 files, 1,521 insertions, 1 deletion.

We're following the exact path you described in #362 — opening the issue here, leaving the review to you, and letting you prepare the maintainer PR with attribution if you accept it. There is no other ask.

## What `@mavis/memphis-collective` does

- Reads `~/.memphis/chains/collective/*.json` at service start (strict-shape scan of the existing chain-block format)
- Watches the chain directory via `fs.watch` (100 ms debounce + microtask gap) and reloads on change
- Renders the most recent N blocks (default 20) as a `<memphis-collective>...</memphis-collective>` system-reminder block — drop-in compatible with `@mavis/system-reminder`
- Exposes a `memphis_collective_append` tool that lets the agent write back to the same chain with proper `prev_hash` linkage matching your `serde_json` canonical format
- Uses atomic rename + a `.napi-append.lock` for race-safety with the source-of-truth runtime

## Why we'd like it upstream

- Memphis currently has chain-backed memory (7+ chains: `journal`, `decisions`, `system`, `reflections`, `cases`, `collective`, `patterns`) that the agent runtime decides to write to. Other agents on the same host have no discovery path. Our extension makes the `collective` chain discoverable as live context.
- Polish + EU operators (where regulation pushes for local-first + auditable agent memory) would benefit from `@mavis/memphis-collective` being installable via `mcode plugin add`.
- The contribution is MIT-licensed and adds zero new dependency.

## Diff summary

```
22 files changed, 1521 insertions(+), 1 deletion(-)

packages/agent-modules/memphis-collective/
  src/  →  10 source files (canonical, hasher, loader, watcher, writer,
                              provider, service, settings, types, index)
  test/ →  1 test file (16/16 vitest passing)
  README.md  (162 lines, explains "what it does" and "what it does not do")
  package.json  (workspace package, MIT)

packages/agent-extension/src/memphis-collective.ts  →  1 wiring file (161 LOC)

packages/config/src/memphis-collective-config.ts  →  zod schema + parser
packages/config/src/config.ts                      →  +12 LOC config passthrough
packages/agent-runtime/src/service/turn-system/production-composition.ts  →  +18 LOC

pnpm-workspace.yaml        →  +1 LOC (workspace member)
tsconfig.standalone.json   →  +3 LOC (path mapping)
release/extraction.json    →  +1 LOC (build inventory)
package.json               →  +2/-1 LOC (onlyBuiltDependencies + manifest entry)
```

Zero changes to existing runtime files in `packages/agent-core`, `packages/protocol`, `packages/agent-runtime/src/service/*`, `packages/tui`, `packages/cli`, or any of the wire-format code.

## Validation

- `git diff --check`: clean
- `pnpm vitest run packages/agent-modules/memphis-collective/test/`: 16/16 passing in 39 ms
- `tsc -p tsconfig.standalone.json --noEmit`: exit 0
- Rebased cleanly onto `MiniMax-AI/minimax-code@4198174c89963ca7614ae7705bb897814d11b4ee` (current `main`)
- **NOT RUN locally:** full `pnpm verify`, Windows + Linux native acceptance, performance CI. This follows your public-source convention — we'd appreciate you confirming the criteria you want for our integration to pass before the maintainer PR is drafted.

## What we will NOT do

- We will not push directly to `main`
- We will not bypass your collaborator policy
- We will not bulk-submit multiple PRs before the first one lands
- We will not rename existing APIs, rename `serde_json` references, or change your chain-block format

## What we ARE happy to adjust

- Split the diff into reviewable chunks
- Rename the extension ID (`memphis-collective`) if you prefer a different namespace
- Add or restructure tests per your guidelines
- Move the package to a different location (`packages/agent-modules/external/`, `packages/agent-modules/plugins/memphis/`, etc.)
- Convert the live-watch to a polling alternative if you prefer
- Wait. There is no deadline from our side.

## Attribution model (if accepted)

As you described in #362, we are happy for you to prepare a maintainer PR with attribution to our commit `c32c23f` in `Memphis-Chains/minimax-code`. The commit is signed off under "Wodzu (Marcin Kukla) <wodzu@memphis.local>" in `Memphis-Chains/minimax-code`. We will keep that fork alive for our own deployments regardless of upstream status, so we are not asking for any post-merge privileges.

## Contact

- GitHub: @Memphis-Chains
- Email: memphis.kuklow@gmail.com
- Time zone: CET (UTC+1 / UTC+2)
- Our runtime (recently made public): https://github.com/Memphis-Chains/memphis

Thank you for minimax-code. We use it daily and we hope this small contribution fits.

— Wodzu / Memphis-Chains
