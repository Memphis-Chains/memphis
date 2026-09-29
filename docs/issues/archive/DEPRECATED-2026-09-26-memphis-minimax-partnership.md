> ⚠️ **DEPRECATED — use `partnerships/2026-09-26-minimax-combined-pack.html` instead.**
> This file is from an earlier iteration of the partnership outreach plan (before we realized GitHub DM is unavailable, so we switched to a single combined GitHub issue).
> See `docs/partnerships/README.md` for the canonical flow.

# Strategic partnership: `memphis-collective` integration + Poland microdata center + Watra.ai franchise

> **From:** Memphis-Chains (Wodzu / Marcin Kukla)
> **To:** MiniMax team (@hetaoBackend, @1anZhang)
> **Context:** I run Memphis — a sovereign AI runtime with chain-backed memory, encrypted vault, and operator console. We operate in Poland. We've built `@mavis/memphis-collective` (working code, 16 tests, MIT-compatible) that lets any mcode agent share the **collective decision audit trail** with a Memphis runtime on the same host.
> **Why I'm writing this as an issue:** your CONTRIBUTING.md says PRs are collaborator-only, so I'm following the right channel. But the deeper ask is **not "merge my code"** — it's **"let's build something together"**.

## What I'm offering (free, MIT, no strings attached)

### 1. Live working integration (commit already pushed)

Public fork with our work, rebased on current `main`:

- **Repo:** https://github.com/Memphis-Chains/minimax-code
- **Commit:** `c32c23f` — `feat(memphis-collective): real-time watch + write bridge between mcode and memphis`
- **Size:** 22 files, 1,521 insertions, 1 deletion (new package + SPI wiring)
- **Tests:** 16/16 passing locally + `tsc -p tsconfig.standalone.json --noEmit` clean
- **License:** MIT (matches your LICENSE)

What `@mavis/memphis-collective` does:
- Reads `~/.memphis/chains/collective/*.json` at service start (strict-shape scan)
- Watches with `fs.watch` (100ms debounce) and reloads on change
- Renders recent N blocks as a `<memphis-collective>…</memphis-collective>` system-reminder block (drop-in for `@mavis/system-reminder`)
- Exposes a `memphis_collective_append` tool that lets the agent write back to the same chain with proper hash linkage (matches your `serde_json` canonical format)
- Atomic rename + `.napi-append.lock` for race-safety with Memphis itself

### 2. Memphis runtime (in production since 2025, MIT license on `crates/memphis-napi`)

What's different from mcode, that your users would care about:

- **7+ chain types** (`journal`, `decisions`, `system`, `reflections`, `cases`, `collective`, `patterns`) vs your 1 memory layer — multi-stream agent memory
- **Encrypted vault** with `pepper` + `master-key-rotate` for secrets
- **Soul manifest** for persistent agent identity + learned user preferences
- **HALT-aware destructive ops** — every `rm`/`mv` checks `~/.memphis/halt/` registry before execution (cron + audit chain)
- **Decision discipline**: anti-confab (VERIFIED / UNVERIFIED / OUT OF SCOPE) embedded in every decision chain entry
- **MCP server** with 23+ typed tools (`memphis_decide`, `memphis_journal`, `memphis_recall`, `memphis_search`, `memphis_soul_write`, `memphis_chain_verify`, etc.)
- **Polish + English + bilingual support** baked in (relevant for EU + China markets)

## What I'm asking for (one of three, your pick)

### Option A — Collaborator invite on `MiniMax-AI/minimax-code`

If you accept our integration on its technical merit, we can do this the standard way:
- You grant `@Memphis-Chains` collaborator on your repo
- We rebase + open a real PR with the rebased commit
- Review happens normally, merge when ready
- **No strings attached** — we keep Memphis independent, we keep our fork, you get the code

This is the simplest path. We just want our work to land upstream so other Polish + EU users can install `@mavis/memphis-collective` via `mcode plugin add` instead of compiling from source.

### Option B — Co-engineering: microdata center in Poland

We are building a microdata center in Poland for sovereign AI workloads (Polish + EU customers who can't use US hyperscalers due to GDPR/FEDRAMP-export-control concerns). We want to talk to MiniMax about:

- **Hardware** — your `Mini-Agent` (3045★) and `OpenRoom` (1267★) reference architectures suggest you operate GPU inference at scale. We need hardware partners who understand dense compute + cold-storage for chain-backed memory archives.
- **Software stack** — your `skills` repo (13.6k★) is the closest thing to our Memphis skills model. Joint work on portable skills between Memphis runtime and mcode could make both ecosystems stronger.
- **Local market access** — Polish + EU public-sector AI market is growing fast (NCBR/akces-ncbr funding, sovereign-cloud requirements). MiniMax models (M1, M2, M3, H3) are not currently widely available through Polish channels.

If this resonates, I'm proposing **a joint venture** for the Polish microdata center:

| Stake | Contribution | Equity |
|---|---|---|
| Memphis-Chains (us) | Site, power, EU regulatory expertise, Memphis runtime integration, operator labor | 80% |
| MiniMax | Hardware spec, M-series model access for Polish customers, joint engineering on Memphis↔mcode skills | **20%** |

The Polish government won't fund us directly (we tried, hence "oswobodzenie" = liberation from local funding dependence). But a Chinese AI partner with skin in the game — that's a different conversation entirely.

### Option C — Watra.ai franchise

We have a project called **Watra.ai** — a marketplace for knowledge packs (maps, ontologies, knowledge graphs, behavioral models). The asset class #1 is "kartografowie" (cartographers) — people and AI systems that build world models. Your `skills` repo is essentially a knowledge-pack ecosystem; our Watra.ai is a marketplace for trading them.

The proposal: **franchise Watra.ai for the Chinese + Asia-Pacific market**. We bring:
- Polish + EU seller pipeline (we already have pilot clients)
- Knowledge-pack format + escrow + reputation system
- Memphis runtime as the buyer-side execution layer

You bring:
- Chinese seller pipeline (your `awesome-minimax-integrations` repo shows you have 79★ worth of community integrations)
- Distribution to Asia-Pacific buyers via your ecosystem
- Model API access for knowledge-pack enrichment

Equity: **20% to MiniMax** in the franchised entity (separate from Option B's equity), with Memphis-Chains controlling product direction and MiniMax controlling regional distribution.

## Why I'm doing this

Three reasons:

1. **Your code is good.** We use it daily. `mcode TUI` is more pleasant than anything we've built in Memphis. `@mavis/oauth-lease-protocol` (in your deps) is a genuinely clever pattern that we want to learn from. The `skills` repo is the right abstraction. You ship weekly. That's rare.

2. **The Polish + EU market needs a serious non-US AI partner.** GDPR, EU AI Act, sovereign cloud requirements. US hyperscalers are too entangled with US foreign-policy export controls. You have the technical depth. We have the regulatory + site relationships. This is a real business.

3. **Our government won't fund this.** We tried. The funding path goes through NCBR/akces-ncbr (Polish National Centre for Research and Development), but their criteria favor incumbent Polish IT vendors, not new entrants. We are the new entrant. So we need a partner who doesn't depend on Polish funding — and you don't.

## What this issue is NOT

- Not a request to merge our code without review
- Not a sales pitch (we have no sales team)
- Not an attempt to bypass your collaborator-only policy
- Not a unilateral action — we wait for your response before any of Options B/C move forward

## What I need from you

Just one of:

1. **Yes/no on collaborator invite** (Option A). Even a "not now, here's why" is useful.
2. **A 30-minute call** to discuss Option B (microdata center joint venture). I can fly to Shanghai or we can do video.
3. **A 30-minute call** to discuss Option C (Watra.ai franchise for Asia-Pacific).

If you're not the right person, please redirect to whoever handles partnerships at MiniMax. I have no idea what your org structure looks like.

## Contact

- **Email:** memphis.kuklow@gmail.com
- **GitHub:** @Memphis-Chains (this account)
- **LinkedIn:** [Wodzu / Marcin Kukla] (findable)
- **Memphis runtime:** https://github.com/Memphis-Chains/memphis (private — can share under NDA)
- **Time zone:** CET (UTC+1/+2)

Dziękuję za przeczytanie. Czekam na odpowiedź.

— Wodzu
