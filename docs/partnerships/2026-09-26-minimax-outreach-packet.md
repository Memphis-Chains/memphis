# MiniMax Partnership Outreach Packet — Ready to Send

> **Status (2026-09-26):** Code shipped to public fork, GitHub direct channels blocked by collaborator-only policy. Manual outreach by operator is the only path forward. This packet is self-contained — copy-paste ready.

---

## STATE ON GITHUB (verified live)

| What | Where | Status |
|---|---|---|
| Public fork with integration | https://github.com/Memphis-Chains/minimax-code | ✅ Live, top 10 newest forks |
| Working commit (rebased on upstream 0.5.4) | `c32c23f` (1 commit ahead) | ✅ Pushed |
| Topics + homepage | `ai-agent`, `framework`, `memory`, `rust`, `typescript` + memphis.github.io | ✅ Set |
| **Issue on MiniMax upstream** | https://github.com/MiniMax-AI/minimax-code/issues | ❌ 403 — needs collaborator invite first |
| **Discussion on MiniMax upstream** | https://github.com/MiniMax-AI/minimax-code/discussions | ❌ 403 |

**Why blocked:** CONTRIBUTING.md + maintainers.md explicitly state "code and documentation PRs are accepted only from repository collaborators." All 32 merged PRs in last 30 days are from 4 collaborator accounts. Community PRs are closed with `wontfix` (precedent: issue #362).

---

## CHANNEL A — Official Contact Form (recommended, manual)

**URL:** https://platform.minimax.io/contact-us

This is the official intake for partnerships (Sales + Developer Programme tracks). The form is JS-rendered, so it must be filled manually by you in your browser. Copy-paste values below:

### Sales track (Option B: microdata center JV, Option C: Watra.ai franchise)

```
Type:         Sales
First Name:   Marcin
Last Name:    Kukla
Email:        memphis.kuklow@gmail.com
Company:      Memphis-Chains
Website:      https://Memphis-Chains.github.io/memphis/
Industry:     Software
Job Title:    Founder
Models:       MiniMax-M3 (current Memphis default), MiniMax-M2.7 (recommended for microdata)
```

**"How can we help?" message:**

```
Hi,

I'm reaching out from Memphis-Chains — we're a Polish-based team that has been
running Memphis, a sovereign AI runtime with chain-backed memory, since 2025.
We're already integrated with your open-source mcode (commit c32c23f, public fork
at github.com/Memphis-Chains/minimax-code).

Two business proposals, mutually exclusive:

(1) Microdata center JV in Poland
    We are building a microdata center in Poland for sovereign AI workloads
    (GDPR/EU AI Act compliance, US hyperscaler alternatives for EU public-sector
    customers). MiniMax models (M1, M2, M3, H3) are not currently distributed
    through Polish channels.

    Proposal:
    - Memphis-Chains: 80% equity — site, power, regulatory expertise,
      Memphis runtime integration, operator labor
    - MiniMax: 20% equity — hardware spec, M-series model access for Polish
      customers, joint engineering on Memphis↔mcode skills

(2) Watra.ai franchise for Asia-Pacific
    We are building Watra.ai — a marketplace for knowledge packs (maps,
    ontologies, knowledge graphs, behavioral models). Your `skills` repo
    (13.6k★) is essentially a knowledge-pack ecosystem.

    Proposal:
    - Memphis-Chains: 20% equity (separate from #1) — Polish + EU seller pipeline,
      knowledge-pack format + escrow, Memphis runtime as buyer-side executor
    - MiniMax: 80%? — Chinese seller pipeline, Asia-Pacific distribution,
      model API for enrichment

OR — keep it simple:
    Grant @Memphis-Chains collaborator invite on MiniMax-AI/minimax-code so we
    can submit the PR for memphis-collective upstream and the integration ships
    to your other users via `mcode plugin add`. Pure OSS, no business strings.

If this is the wrong channel for partnerships, please redirect to whoever
handles EMEA / strategic partnerships at MiniMax. The Polish + EU market
needs a serious non-US AI partner; we have the regulatory + site relationships;
you have the technical depth and a 200M-user global ecosystem.

I can fly to Shanghai or do video. Let me know what works.

Best,
Marcin "Wodzu" Kukla
Memphis-Chains | github.com/Memphis-Chains

[Code proof: github.com/Memphis-Chains/minimax-code @ c32c23f]
[Integration demo: 16/16 tests, MIT-compatible, drops into @mavis/system-reminder SPI]
```

### Developer Programme track (Option A: just merge the code)

Same identity fields. Message:

```
Hi,

We've built @mavis/memphis-collective — a reader/writer bridge between your
mcode agent and the memphis `collective` chain. Working code, 16 tests passing,
MIT-compatible. Rebased on your current main, pushed to:

  https://github.com/Memphis-Chains/minimax-code  (commit c32c23f)

What's inside:
- Reads `~/.memphis/chains/collective/*.json` at boot (strict-shape scan)
- Watches with fs.watch + 100ms debounce
- Renders recent N blocks as <memphis-collective>...</memphis-collective>
  reminder block (drop-in for @mavis/system-reminder)
- Exposes memphis_collective_append tool with hash linkage matching your
  serde_json canonical format
- Atomic rename + .napi-append.lock for race-safety

We'd like a collaborator invite so we can submit a real PR upstream. Your
CONTRIBUTING.md says only collaborators can submit PRs; we understand and
respect that policy. This message is asking for the invite, not bypassing it.

No business strings — just want our work to ship to your other users.

Best,
Marcin "Wodzu" Kukla
Memphis-Chains
```

---

## CHANNEL B — Email to `api@minimax.io`

**To:** `api@minimax.io` (from official footer of minimax.io)

**Subject:** `Strategic partnership: memphis-collective integration + Polish microdata center + Watra.ai franchise`

**Body:** Same as Sales track message above.

> Note: I don't have SMTP configured on this host. To send, run on your local
> machine:
> ```bash
> echo "$BODY" | mail -s "$SUBJECT" -r memphis.kuklow@gmail.com api@minimax.io
> ```
> Or use Gmail/Thunderbird. If Gmail is needed, draft this in Gmail's web UI
> and send directly.

---

## CHANNEL C — Twitter/X via @MiniMax__AI (low priority, low signal)

Their verified Twitter handle per official site: `@MiniMax__AI`. I checked
both 1anZhang and hetaoBackend profiles — neither has a Twitter handle
visible. Their org handle is the only public route.

A tweet tagging @MiniMax__AI with the fork URL has been considered but
deferred — too low-signal to be worth the noise.

---

## CHANNEL D — Discord (Agent Plugins community)

**URL:** https://discord.gg/692jE8wsmj (from agent-plugins.org Discord link)

This is where MiniMax is one of 5+ TSC orgs alongside Amazon, Cursor,
Microsoft, OpenAI, Vercel. **Higher signal than Twitter, lower than
direct outreach.** Could be a backup if email + form don't get responses
in 2 weeks.

---

## TIMELINE (after you send)

| Day | Action |
|---|---|
| Day 0 | You send form + email |
| Day 1-3 | Wait (they have form queue) |
| Day 7 | If no response, ping me — I'll check Discord option |
| Day 14 | If still no response, escalate: try @hetaoBackend via any other channel |

---

## BACKUP: Operator's own contacts

If you have any personal contacts at MiniMax (former colleague, conference
met, etc.), use those — they will be 10x more effective than cold outreach.
Direct human connection beats 8000-word pitch every time.

---

## FILES TO ATTACH (if they ask for more)

| File | Path | Purpose |
|---|---|---|
| Memphis architecture diagram | (you need to make this; ~1 page) | Shows chain-backed memory, vault, soul, HALT |
| Watra.ai pitch deck | (you need to make this; ~5 slides) | Franchise opportunity |
| Polish microdata center plan | (you need to make this; ~5 slides) | Site, power, business model |
| Memphis source code preview | github.com/Memphis-Chains/memphis (private — share under NDA) | Code quality |

I cannot generate the Memphis architecture deck without seeing your vault
docs, decision chain, or the actual memphis runtime source. If you have
~30 min, I can:
1. Read memphis docs/decisions
2. Generate an architecture diagram (Mermaid + 1-page narrative)
3. Save to `~/memphis/docs/partner-pitch/`

Just say "build the pitch deck" and I'll do it.

---

## ANTI-CONFAB (verified 2026-09-26)

**Direct GitHub channels blocked:**
- `gh issue create --repo MiniMax-AI/minimax-code` → 403 (NOT_FOUND/Resource not accessible)
- GraphQL `createDiscussion` → FORBIDDEN
- `gh issue comment` → 403 (NOT_FOUND)

**Our permissions on our fork:**
- `Memphis-Chains/minimax-code`: admin=true, maintain=true, push=true (we own it)

**Upstream merge policy (verbatim from CONTRIBUTING.md):**
> "For now, we only accept code and documentation contributions from
> repository collaborators. If you are not a collaborator but have an idea
> or proposal, please open an issue so we can discuss it."

**Maintainers (verified):**
- @hetaoBackend (DanielWalnut) — release coordinator, CODEOWNERS owner, 23 merged PRs
- @1anZhang (vesper, Shanghai) — MiniMax employee, 6 merged PRs

**Official partnership channel:**
- https://platform.minimax.io/contact-us (Sales + Developer Programme tracks)
- Email: api@minimax.io (from official footer)
- No Twitter DMs viable (no employee handles)

**All paths converged on: you must manually send via the contact form or email.**
The integration code is shipped. The rest is human communication.

---

**Czekam na Twój ruch. Jak tylko dasz "wysłałem" albo "zrób pitch deck" — kontynuuję.**
