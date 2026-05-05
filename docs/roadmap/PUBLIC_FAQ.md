# Public FAQ — Memphis

> **Cel:** odpowiedzi na 10 pytań, które dostają autorzy Memphis najczęściej — od inwestorów, operatorów technicznych, grant-reviewerów i osób oceniających "czy to zaufać".
> **Reguła:** każda odpowiedź **linkuje do kotwicy ewidencji** (kod, PR, doc). Jeśli czegoś nie ma w kodzie — mówimy to wprost.
> **Status:** roadmap-related stwierdzenia używają znaczników z `HONESTY-LEGEND.md` (✅/⏳/🔬/📐/⚠️).

---

## 1. Czy Memphis działa offline?

**Tak — w 100% gdy używasz lokalnych providerów.**

Default'owy provider to Ollama (lokalny, RTX/GTX accel albo CPU). Wszystkie chains, vault, Kartograf embedding, voice (jeśli zainstalujesz lokalny stack) działają bez Internetu. Wyłączasz Wi-Fi → Memphis dalej rozmawia, pisze do journal'a, robi semantic recall.

Jeśli wybierzesz chmurowego providera (Anthropic, MiniMax, GLM, DeepSeek) — wtedy ten konkretny tool (chat completion) wymaga Internetu, ale reszta runtime'u dalej offline.

**Evidence:** `src/providers/runtime.ts` (cascade), `OLLAMA_URL=http://127.0.0.1:11434` w `.env`, `MEMPHIS_VOICE_MODE=local` w voice section, `crates/memphis-napi/` (vault + chains nigdy nie wychodzą z boxa).

## 2. Co jeśli moja karta graficzna spali?

**Nic krytycznego się nie dzieje.** Memphis nie wymaga GPU.

- **Bez GPU:** Ollama leci na CPU (wolniej, ale działa), Kartograf embedding leci na CPU INT8 (ONNX runtime ma CPU EP), voice fallback na CPU faster-whisper INT8.
- **Z GPU spaloną:** ten sam config — wymieniasz GPU, restartujesz, wraca.
- **Bez Internet ratunku:** lokalny fallback (`local-fallback-v0`) zawsze odpowie czymś, nawet trywialnie. Memphis nie zostawia operatora bez agenta.

Hardware roadmap zakłada GTX 960 (4 GB VRAM) jako baseline — wszystko w roadmapie #1-#13 mieści się w tym budgecie. Coś mocniejszego = szybciej, nie inaczej.

**Evidence:** `src/providers/local-fallback.ts`, `Y1 roadmap v3.1` § "Hardware budget", `KARTOGRAF-SPEC.md` § "GTX 960 4GB".

## 3. Czy moje dane wyjdą z mojej maszyny?

**Domyślnie — nie. NIC.**

Vault (sekrety) — szyfrowane AES-256-GCM, klucz wyprowadzony z Twojej passphrase, NIGDY nie eksportowane. Chains — append-only na lokalnym dysku, podpisane Twoim Ed25519. Kartograf embedding — lokalny ONNX inference, sample tekstu nie wychodzi do chmury.

Wychodzi **tylko gdy:**
1. **Sam wyślesz prompt do chmurowego LLM providera** (Anthropic/MiniMax/...) — wtedy ten konkretny prompt + odpowiedź lecą tam i wracają. Nigdy historia.
2. **Sam włączysz federation Matrix** — wybrane chains synchronizują się z TWOIMI innymi maszynami (Station ↔ Nomad). Nigdy do central server.
3. **Sam zrobisz `memphis export --format=mv2 --public --redact`** — i wybierzesz redact level. Default = wszystko zostaje na boxie.

**Evidence:** `crates/memphis-core/src/vault/`, `~/.memphis/vault-entries.json` (file mode 0600), `src/federation/mp/envelope.ts` (operator-keyed), `crates/memphis-export/src/mv2/privacy.rs`.

## 4. Jak działa federacja?

**Peer-to-peer przez Matrix transport, bez central server.**

Operator A i operator B (lub Twoje desktop ↔ laptop) mają swoje Ed25519 keypair. Wymieniają DID (decentralized identifier) raz, ręcznie. Potem `memphis kartograf publish --source federation --peer <did>` wysyła signed checkpoint przez Matrix room. Recipient weryfikuje signer, decyduje czy promote do active (`--force-active`) czy zostawia jako baseline.

**Stan dziś:** spec'd w `Y1 roadmap v3.1` N14, MP envelope shipped w `src/federation/mp/`. Pełny pipeline = Q3 2026.

**Czego NIE ma:** Matrix homeserver Memphis-Chains. Spinacie się przez self-hosted Synapse albo public room — Twój wybór. Memphis nie żąda żebyście używali ich infrastruktury.

**Evidence:** `MEMPHIS-FEDERATION-DESIGN.md`, `src/federation/mp/{envelope,operator-key}.ts`, `Y1 roadmap v3.1` § federation rules 9-12.

## 5. Ile to kosztuje?

**Memphis runtime: 0 zł / miesiąc.** Open source (Apache-2.0), self-hosted, no SaaS fee.

**Co kosztuje (opcjonalnie):**
- **Cloud LLM provider** (jeśli wybierzesz Anthropic/MiniMax/GLM/DeepSeek): per-token, varies. Możesz w ogóle nie używać — Ollama lokalnie jest free.
- **GPU** (jeśli chcesz lokal): GTX 960 starczy (~150 zł used), RTX 3060 12 GB lepiej (~1200 zł), RTX 4060 / nowsze = wygoda.
- **Cloud teacher training** dla Kartograf v2 LoRA (Y2): ~$10-50 jednorazowo na RunPod / Modal jeśli chcesz fine-tunować na większym modelu niż lokalny się da. Opcjonalne.

**Czego nie ma w cenniku:** subskrypcji. Vendor lock-in. Hidden API fees.

**Evidence:** [LICENSE](../../LICENSE) (Apache-2.0), `package.json` (no paid deps), `Y1 roadmap v3.1` § Q4 cost section.

## 6. Dlaczego Polish-first?

**Bo autor jest Polakiem i jego operatorzy mówią po polsku.** Pragmatic, nie ideologiczne.

- TUI rozumie polskie znaki (UTF-8 forced w `setup_utf8_locale`)
- Voice stack: pl_PL-gosia / pl_PL-darkman jako default
- INSTALL.pl.md, QUICKSTART.md po polsku
- Roadmap pkt #11 priorytuje Polka-1.1B (Speakleash) jako lokalny model fine-tune base

**Co to nie znaczy:** Memphis działa po angielsku tak samo dobrze. Nie jest "Polish-only". Multilingual cascade (Qwen2.5, MiniMax, Anthropic) supports both.

**Evidence:** `crates/memphis-tui/src/main.rs:setup_utf8_locale`, `INSTALL.pl.md`, voice install gosia default, `system-prompt.ts` ("speak Polish and English").

## 7. Dlaczego sovereignty? Co to znaczy konkretnie?

**Sovereignty = operator owns the box, operator owns the data, operator owns the keys.**

Konkretnie:
1. **Box:** Memphis działa na Twoim hardware. Zero managed cloud.
2. **Data:** chains + vault siedzą na Twoim dysku. Ty decydujesz kiedy wychodzą (cloud LLM call, federation peer, eksport).
3. **Keys:** Ed25519 dla podpisów, AES-256-GCM dla vault, Twoja passphrase wywodzi master key. Nigdzie nie eksportowane.
4. **Code:** open source, audytowalny, możesz forknąć i odejść.
5. **Federation:** opcjonalna, peer-to-peer, bez central server.
6. **Provenance:** każda odpowiedź agenta ma footer `— via {provider}/{model}` żebyś wiedział kto faktycznie wygenerował tekst.

**Co to nie znaczy:** "Memphis nigdy nie używa chmury". To znaczy: **Ty wybierasz** kiedy używa, nie default-on przez kogoś innego.

**Evidence:** `crates/memphis-core/src/{signature,vault}.rs`, [LICENSE](../../LICENSE) Apache-2.0, PR #463 (provider stamp), `MEMPHIS-FEDERATION-DESIGN.md`.

## 8. Gdzie jest kod? Czy mogę go audytować?

**Wszystko na GitHub: `Memphis-Chains/memphis`.**

Audit poziomy:
1. **Read-the-source:** publiczny repo, ~110k LOC TS + Rust. Każda linia visible.
2. **Reproducible build:** `npm install && npm run build` z lockfiles. Wynik bit-by-bit identyczny dla danego commit'a.
3. **Signed releases:** GitHub releases + tag SHA. Reproducible w CI.
4. **Self-modify audit chain:** każda zmiana którą agent robi sam zostaje w `journal` chain z hash linkiem. Ty widzisz historię "co kod zrobił do mojej maszyny".
5. **Codex / external review:** każdy PR przechodzi review (Codex automated + human gates). Zobacz `https://github.com/Memphis-Chains/memphis/pulls?q=is%3Apr+is%3Amerged`.

**Co możesz zrobić DZIŚ:**
- Klonować repo → `git log --all` → przeczytać commit messages
- Run `bash <(curl ...) --check-only --json` → zobacz co installer planuje zrobić zanim go uruchomisz
- `memphis evolve log` → historia self-modify changes na Twoim boxie

**Evidence:** GitHub repo, `scripts/install.sh --check-only`, PR #386-#389 (security & honesty Sprint S5), `src/infra/audit/`.

## 9. Jak audytować w produkcji?

**Trzy mechanizmy:**

1. **Signed-block chains.** Każdy block w chain ma SHA-256 hash linku do poprzedniego + Ed25519 signature operatora. `memphis chain verify` przechodzi cały chain i powie jeśli ktoś coś zmienił. Niemożliwe sfałszowanie post-facto bez Twojego klucza.

2. **Provider stamp.** Każda odpowiedź ma footer `— via {provider}/{model}`. Jeśli ktoś (Ty, Twój zespół, future-Ty) czyta historię chat'u i zastanawia się "kto to napisał — cogito, MiniMax, Claude?" — odpowiedź jest w wiadomości.

3. **Self-modify audit chain.** Memphis może modyfikować swój własny kod (tier-2 tool z passphrase). Każda taka zmiana to wpis do `journal` z snapshot diff'em + hash sygnaturą. `memphis evolve log` ją pokaże.

**Plus:** `memphis doctor --deep` weryfikuje integralność wszystkich chains, vault, embeddings — daje JSON status z którego możesz zbudować nightly cron.

**Evidence:** `crates/memphis-core/src/{signature,chain}.rs`, PR #463 (provider stamp), `src/mcp/tools/self-modify.ts` (audit-on-write), `memphis doctor --deep` shipped.

## 10. Kiedy AGI?

**Memphis nie obiecuje AGI.**

Memphis dostarcza **suwerennego asystenta z lokalną pamięcią + audytem + opcjonalną federacją**. Tyle.

Co to znaczy:
- ✅ Pamięta kontekst latami (chains)
- ✅ Uczy się Twoich preferencji (Kartograf nightly retrain w roadmapie)
- ✅ Wykonuje narzędzia w Twoim systemie z audytem (39 tools, tier-gated)
- ✅ Działa offline, decentralizowany, audytowalny
- ❌ NIE jest świadomy
- ❌ NIE rozwiązuje generalnej inteligencji
- ❌ NIE zastąpi człowieka w decyzjach moralnych

LeWorldModel (#12 w roadmapie) doda **percepcję sensora** — Memphis "zauważy" że maszyna zachowuje się dziwnie. To nie AGI, to specialized predictor. World models ≠ general intelligence.

**Jeśli ktoś sprzedaje Ci AGI — sprawdź lockfile.**

**Evidence:** `HONESTY-LEGEND.md` § "AGI nie pojawia się na liście", `ROADMAP_2026_2030.md` § "Świadomie pominięte" (AGI claims), `LEWM-INTEGRATION-PROPOSAL.md` §9 explicitly bounds scope.

---

## Cross-references

- Pełna roadmap: [`ROADMAP_2026_2030.md`](./ROADMAP_2026_2030.md)
- Legenda znaczników: [`HONESTY-LEGEND.md`](./HONESTY-LEGEND.md)
- Wewnętrzny Y1 plan: [`Y1-2026-05-to-2027-05.md`](./Y1-2026-05-to-2027-05.md)
- Federation design: [`../../MEMPHIS-FEDERATION-DESIGN.md`](../../MEMPHIS-FEDERATION-DESIGN.md)
- LeWM proposal: [`../dev/LEWM-INTEGRATION-PROPOSAL.md`](../dev/LEWM-INTEGRATION-PROPOSAL.md)
- Install: [`../../INSTALL.md`](../../INSTALL.md) (en) / [`../../INSTALL.pl.md`](../../INSTALL.pl.md) (pl)

---

## Stylowo: jak Wodzu mówi o Memphis

> *"Memphis nie jest produktem. Memphis jest narzędziem operatora. Operator owns box, owns data, owns keys. Wyłączysz Internet — agent dalej rozmawia. Forkniesz repo i odejdziesz — agent dalej Twój."*

To jest pragmatyczna sovereignty, nie ideologia. Działający kod, zaufanie zbudowane na audycie, nie na hasłach.
