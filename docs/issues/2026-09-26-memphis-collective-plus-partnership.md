# memphis-collective integration + Polish channel partnership — for technical review + commercial discussion

> **Author:** @Memphis-Chains (Wodzu / Marcin Kukla, Zawoja, Małopolska, Poland)
> **Repo of proposed work:** https://github.com/Memphis-Chains/minimax-code
> **Branch / commit:** `c32c23f` (rebased on your current `main`)
> **Memphis runtime:** https://github.com/Memphis-Chains/memphis (Apache-2.0, just made public)
> **Category:** open-source contribution proposal + parallel channel/distribution partnership inquiry

## TL;DR (two things, related but separable)

**(A) OSS contribution** — same pattern as #362 / #364:

We've written `@mavis/memphis-collective`, an MIT-licensed extension that bridges the memphis `collective` chain into `@mavis/system-reminder` without changes to existing files outside the new package directory. 22 files, 1,521 insertions, 1 deletion. Rebased on your current main. 16/16 tests pass. `tsc -p tsconfig.standalone.json --noEmit` clean. We're following the exact workflow you described in #362 — opening the issue, leaving technical review to you, and letting you prepare a maintainer PR with attribution if you accept.

**(B) Channel / distribution partnership** — new ask:

Independently of (A), we would like to discuss becoming a **local channel for MiniMax in Poland**, focused on three service lines:

1. **MiniMax model API distribution** to Polish + EU customers (B2B sales, integration support, locally-billed contracts) — we already operate in the Polish micro-business ecosystem with established relationships with NCBR-affiliated founders and Powiatowy Urząd Pracy Sucha Beskidzka.
2. **mcode deployment and integration consulting** — Memphis runtime + mcode as a combined local-first AI stack for Polish public-sector and EU-regulated workloads (where GDPR + EU AI Act + sovereign-cloud requirements push customers away from US hyperscalers).
3. **Kartograf / knowledge-pack marketplace operator** — we are building Watra.ai (a marketplace for knowledge packs: maps, ontologies, knowledge graphs, behavioral models). We see MiniMax's `skills` repo (13.6k★) as a near-perfect fit — happy to discuss distribution or technical alignment there too.

We are NOT asking for funding, investment, equity dilution, or special API pricing in this first message. We are asking whether MiniMax has a process for evaluating regional channel / distribution partners, and whether the right person to talk to is you or someone we should be writing to instead.

## PART A — OSS contribution (technical detail)

### What `@mavis/memphis-collective` does

- Reads `~/.memphis/chains/collective/*.json` at service start (strict-shape scan matching your existing chain-block format)
- Watches the chain directory via `fs.watch` (100 ms debounce + microtask gap) and reloads on change
- Renders the most recent N blocks (default 20) as a `<memphis-collective>...</memphis-collective>` system-reminder block — drop-in compatible with `@mavis/system-reminder`
- Exposes a `memphis_collective_append` tool that lets the agent write back to the same chain with proper `prev_hash` linkage matching your `serde_json` canonical format
- Uses atomic rename + a `.napi-append.lock` for race-safety with the source-of-truth runtime

### Diff summary

```
22 files changed, 1521 insertions(+), 1 deletion(-)

packages/agent-modules/memphis-collective/   (NEW PACKAGE)
  src/         10 source files (canonical, hasher, loader, watcher, writer,
                                  provider, service, settings, types, index)
  test/         1 test file (16/16 vitest passing)
  README.md    162 lines
  package.json MIT

packages/agent-extension/src/memphis-collective.ts   (NEW — 161 LOC SPI wiring)
packages/config/src/memphis-collective-config.ts    (NEW — zod schema + parser)
packages/config/src/config.ts                        (+12 LOC passthrough)
packages/agent-runtime/src/service/turn-system/production-composition.ts  (+18 LOC)

pnpm-workspace.yaml                +1 LOC
tsconfig.standalone.json           +3 LOC
release/extraction.json            +1 LOC
package.json                       +2/-1 LOC
```

Zero changes to: `packages/agent-core`, `packages/protocol`, `packages/agent-runtime/src/service/*` existing files, `packages/tui`, `packages/cli`, wire-format code.

### Validation

- `git diff --check`: clean
- `pnpm vitest run packages/agent-modules/memphis-collective/test/`: 16/16 passing in 39 ms
- `tsc -p tsconfig.standalone.json --noEmit`: exit 0
- Rebased cleanly onto `MiniMax-AI/minimax-code@4198174c89963ca7614ae7705bb897814d11b4ee` (current `main`)
- **NOT RUN locally:** full `pnpm verify`, Windows + Linux native acceptance, performance CI. This follows your public-source convention — we'd appreciate you confirming the criteria you want for our integration to pass before the maintainer PR is drafted.

### What we will NOT do (OSS scope)

- We will not push directly to `main`
- We will not bypass your collaborator policy
- We will not bulk-submit multiple PRs before the first one lands
- We will not rename existing APIs, rename `serde_json` references, or change your chain-block format

### What we ARE happy to adjust (OSS scope)

- Split the diff into reviewable chunks
- Rename the extension ID (`memphis-collective`) if you prefer a different namespace
- Add or restructure tests per your guidelines
- Move the package to a different location (`packages/agent-modules/external/`, `packages/agent-modules/plugins/memphis/`, etc.)
- Convert the live-watch to a polling alternative if you prefer
- Wait. There is no deadline from our side.

### OSS attribution model

As you described in #362, we are happy for you to prepare a maintainer PR with attribution to our commit `c32c23f` in `Memphis-Chains/minimax-code`. The commit is signed off under "Wodzu (Marcin Kukla) <wodzu@memphis.local>". We will keep that fork alive for our own deployments regardless of upstream status, so we are not asking for any post-merge privileges.

---

## PART B — Channel / distribution partnership (this is the new ask)

### Why now (and why OSS contribution was first)

You told us in #362: *"Opening this issue was the correct entry point: external PRs are currently restricted to repository collaborators. There is no need to work around that restriction; we can coordinate the proposal here and prepare a maintainer PR with attribution to your original commit."*

That gave us the technical workflow. We think the same logic applies to a **commercial** workflow: we propose a small, scoped experiment below, and if it works for both sides, we grow. If it doesn't, we walk away clean — the OSS contribution lands either way.

### What we observed about MiniMax + Poland

- MiniMax is on the **Polish EU digital-sovereignty radar**: we have read the Polish government + NCBR documents that describe a need for non-US AI providers for public-sector workloads (PUP Sucha Beskidzka materials, NCBR Horyzontalny Program Naukowy materials).
- Polish developers tell us they want M-series models (M3, M2.7, H3) for local-first workloads but report no clean distribution path through EU GDPR-compliant channels.
- Your `skills` ecosystem (13.6k★) is a natural fit for the Watra.ai knowledge-pack marketplace we are building.

### What we propose (small, scoped, 90-day pilot)

**Pilot structure** — we run this for 90 days and report:

| Component | Owner | Deliverable |
|---|---|---|
| **Polish-language sales** of MiniMax API access for B2B customers | Memphis-Chains | at least 3 paying Polish B2B customers by day 90, baseline MRR at least 5,000 EUR |
| **Local billing + PLN/EUR invoicing** for Polish + EU customers | Memphis-Chains | Polished billing pipeline, VAT-compliant |
| **mcode deployment + integration consulting** for Polish customers | Memphis-Chains | at least 2 deployments in production at Polish customer sites |
| **Polish-language API documentation + onboarding materials** | Memphis-Chains | Translated and reviewed docs, sample integrations |
| **Formal distribution partner agreement** (if pilot succeeds) | MiniMax | Standard reseller / channel agreement with defined margins |
| **Polish-language support tier 1** (during business hours CET) | Memphis-Chains | SLA-defined support window with escalation path to MiniMax L2/L3 |

**What MiniMax would need to provide during the pilot** (low commitment, low risk):

- Direct API access for B2B distribution (not the public token-plan — a partner-level allocation)
- Permission to use the MiniMax brand + minimax-code logos for Polish market
- One named contact on the MiniMax side for partner questions
- A short, written "partner during pilot, no commitment past 90 days" letter we can show prospective Polish customers

**What we are NOT asking for at the pilot stage**: special token pricing, exclusive territory rights, equity participation, exclusivity on any vertical, joint entity formation, NDA before pilot (we can sign one if you require, but we don't need to read your source code to run a sales pilot).

### Why us (briefly, in case context is useful)

We are a small operator, but we are local and we ship. Concrete things we have done:

- **Memphis runtime** — chain-backed memory with vault + soul manifest + HALT-aware destructive ops. Apache-2.0, v1.13.3 in production on this host. Source just made public at https://github.com/Memphis-Chains/memphis.
- **`@mavis/memphis-collective`** — the OSS contribution in Part A above.
- **Watra.ai** — knowledge-pack marketplace (in development), leverages Memphis as buyer-side executor.
- **Concrete Polish footprint** — Małopolska + Podhale, ties to Powiatowy Urząd Pracy Sucha Beskidzka + NCBR Horyzontalny Program Naukowy; we know the Polish micro-business + JDG to PSA transition market.

### Anti-confab for this proposal

- We are NOT asking for funding, investment, equity dilution, or guaranteed API pricing.
- We are NOT asking you to commit to anything beyond the 90-day pilot scope.
- We are NOT asking for exclusivity on Poland or any other territory.
- We are NOT asking for your source code or any NDA-protected material.
- The OSS contribution in Part A is independent and stands on its own merits.
- If the pilot does not work for either side, we end it cleanly.

### How we suggest proceeding

If a regional channel / distribution conversation is even the kind of thing MiniMax considers, we suggest:

1. **Week 1** — you read Part A + skim Memphis runtime; if #362-style maintainer PR is in scope, we are happy to wait for that to land first. We do not need an answer on Part B for Part A to proceed.
2. **Week 2** — if MiniMax does have a partnership intake path, you redirect this Part B to the right person (or reply with "here's who to talk to").
3. **Week 4** — if redirected, one short call (30 min) to align on the 90-day pilot shape.
4. **Week 13** (day 90) — joint review of pilot results. Either scale, redesign, or end.

There is no deadline from our side. We will keep the OSS contribution thread going regardless of Part B timing.

---

## Contact

- **GitHub:** @Memphis-Chains
- **Email:** memphis.kuklow@gmail.com
- **Time zone:** CET (UTC+1 / UTC+2)
- **Phone / Signal / WeChat:** available on request
- **Memphis runtime:** https://github.com/Memphis-Chains/memphis
- **Public fork with integration:** https://github.com/Memphis-Chains/minimax-code @ c32c23f

Thank you for minimax-code — both for the technical surface and for the prompt, honest collaboration style your maintainers demonstrate in issue threads. We are writing this because we genuinely want to work with you, not because we need your approval.

— Wodzu / Memphis-Chains
