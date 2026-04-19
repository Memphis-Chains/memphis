# Zakładki + Review planu Memphis — 2026-04-18

> Plik łączy: (1) review planu architektonicznego Memphis z `~/memphis/review.md` (cuddly-plotting-backus), (2) uporządkowany index 62 zakładek z eksportu Chrome `bookmarks_4_18_26.md.html` z opisami i linkami.

---

## CZĘŚĆ I — Review planu Memphis (uzupełnienie do cuddly-plotting-backus)

Plan jest solidny — function evaluation template to mocna dyscyplina, Blueprint jako single-source-of-truth łapie 4-way drift, local-LLM invariant CI-enforced to zabezpieczenie egzystencjalne. Poniżej **6 luk**, które warto domknąć **zanim wystartują sprinty**:

### 1. Open decisions #1 i #2 to blockery NA TERAZ, nie "at phase entry"

- **#1 — Frontend Tauri:** React+shadcn vs Svelte vs Leptos. Każdy pociąga inny dep stack, inny pipeline buildowy, inny ekosystem testowy. Nie da się "zacząć Phase G skeleton" bez tej decyzji.
- **#2 — Systray yes/no:** decyduje czy Memphis to single-process GUI czy background daemon + on-demand window. Inne IPC lifecycle, inny installer, inne uprawnienia AppArmor.

→ **Action:** podejmij obie decyzje przed sprintem 1, nie czekaj do Phase G.

### 2. Phase 3 (memphis-ml integration) jest niedoszacowana

Estimate: 5–6 PRs / ~2k src + ~1.5k test. Realnie:
- `ml-vm` jest broken (potwierdzone w Phase 1 research)
- swap `ml-p2p` raw-TCP → memphis sync-manager adapter
- nowy `ml-hw-memphis-llm` backend
- determinism-tracing hooks dla replay

→ **Action:** **1-tygodniowy spike PRZED zaklepaniem 8–12wk timeline.** Wynik spike'u: decyzja "fix ml-vm vs rip out". Inaczej utkniesz w Phase 3b z odsłoniętym scope creepem.

### 3. Dual-chain atomicity — sam lock nie wystarczy

`withAppendLockAcrossChains` chroni przed concurrent access, ale **NIE** przed crash pomiędzy dwoma `fsync()`. Rollback appended bloku = truncate (OK), ale potrzebujesz **sentinel/WAL marker** żeby po crashu wykryć "pair-in-progress" i albo complete albo rollback.

Inaczej: `trust.chain` ma pin, `trusted.chain` nie ma → forensic audit już niepełny. Function evaluation Phase T nic o crash-recovery nie mówi.

→ **Action:** dodaj invariant `I3. Crash mid-write recoverable on next boot` + odpowiedni test (kill -9 między fsync, restart, replay).

### 4. Virtualizowany clock dla ML contracts

"Deterministic replay from journal" działa gdy journal capture'uje **całe** I/O. Ale `Date.now()` / system time to też I/O — trzeba to wirtualizować (clock injected z contractu albo deterministycznie z bloku hash'a/timestamp).

→ **Action:** dodaj do Phase 3b prereqs: "ML programs get virtualized clock; system time access disallowed at AST-validation time".

### 5. Agora threat-model walidacja — brakuje fazy "attack it"

Phase 0 pisze `docs/AGORA-DESIGN.md` z threat modelem (sybil, wash-trading, slash collusion). Ale **nie ma fazy "atak na własną ekonomię"** przed Phase 5 UX ship.

→ **Action:** **Phase 4.5 — Adversarial sim** na testnecie (1 tydzień): symulowany sybil swarm, wash-trading, slash-vote collusion. Phase 5 nie ship'uje publicznie dopóki sim nie pokaże, że 4-warstwowy trust model trzyma się pod znanymi atakami.

### 6. Vault-unlock lifecycle w Tauri — nie zaadresowane

Każda finance/trust op → vault-2FA modal. Ale plan nie mówi **jak Tauri trzyma stan "unlocked" między operacjami**:
- Per-op prompt → UX okropny (operator klika 5× w trakcie jednego flow)
- Session z timeoutem → security risk (kradzież device w stanie unlocked)
- Hybrid: per-op dla finance, krótki session dla reszty → kompromis

→ **Action:** spec w Phase G section "Operator auth model" + zapisać decyzję w Blueprint (sam timeout konfigurowalny przez operatora).

### Co JEST dobrze i nie ruszać

- Function Evaluation Template (7 sekcji) jako definition-of-done
- Blueprint Config eliminuje 4-way drift env/GUI/MCP/docs
- Local-LLM invariant CI-enforced — egzystencjalne zabezpieczenie suwerenności
- Trust dual-chain (current + forensic) — pomysł zdrowy
- Phase L jako quick-win pierwszego sprintu (0.5 tyg, 1 PR)

---

## CZĘŚĆ II — Index zakładek (62)

Eksport: `C:\Users\memphis\Documents\bookmarks_4_18_26.md.html` (4 foldery + root).

### 📁 Bookmarks › oswobodzeni › workflow › main

Aktywny workflow Wodzu — codzienne narzędzia + Memphis dev surface.

1. **[Gmail — verify your email](https://mail.google.com/mail/u/0/#inbox/FMfcgzQfBsnXPKfrbFszXTDBXDgrzDnD)** — link weryfikacyjny do `elathoxu@gmail.com`. Prawdopodobnie wygasł, można usunąć.
2. **[Telegram Web](https://web.telegram.org/k/)** — webowa wersja Telegrama (chat z Jurkiem przez ten kanał).
3. **[Roadmap: System Plików dla Oswobodzonych (v2)](file:///C:/Users/memphis/Desktop/Roadmap-v2-2026-02-15.html)** — lokalny plik HTML z roadmapem "Oswobodzonych" (ruch). Lutowa wersja.
4. **[github.com/elathoxu-crypto/memphis](https://github.com/elathoxu-crypto/memphis)** — **fork/lustro Memphis** (oryginał: `Memphis-Chains/memphis`). Local-first AI brain z persistent memory chains. Sprawdzić czy aktualny względem main repo.
5. **[Pinata IPFS Files](https://app.pinata.cloud/ipfs/files)** — Pinata, managed IPFS pinning service. Trzymasz tu coś?
6. **[ChatGPT — "Czytanie z GitHub"](https://chatgpt.com/c/6994dfa1-13d8-8387-bfb5-ea0eb7721487)** — sesja ChatGPT.
7. **[Claude — "Refaktor projektu Memphis"](https://claude.ai/chat/2ff6bc96-2750-4079-b29b-59135d8e1c92)** — sesja Claude.ai o refaktorze Memphis.
8. **[Perplexity — credentials → blockchain log](https://www.perplexity.ai/search/reviev-and-make-a-log-on-block-.Pzk2iZaSyeymkpWpxBqrA)** — Perplexity search "review and make a log on blockchain and desktop out of those credentials" (brzmi jak vault audit).
9. **[Grok / X — konwersacja](https://x.com/i/grok?conversation=2023874623600030157)** — sesja z Grokiem na X.
10. **[AI/ML API — API Keys](https://aimlapi.com/app/keys)** — `aimlapi.com`, agregator dostępu do >300 modeli AI przez jedno API. Konsola kluczy.
11. **[Mistral AI — Organization API keys (admin)](https://admin.mistral.ai/organization/api-keys)** — admin Mistrala, klucze organizacji.
12. **[Mistral AI Studio (console)](https://console.mistral.ai/home)** — konsola Mistrala (chat / API explorer).

---

### 📁 Bookmarks › oswobodzeni

"Bibliotka rzeczy do ogarnięcia" — narzędzia AI/dev, repo OSS, prywatność, polskie programy publiczne.

13. **[Windows LTSC Download | MAS](https://massgrave.dev/windows_ltsc_links)** — MASsgrave: linki do oficjalnych Windows LTSC ISO + aktywator (`MAS`, popularny KMS-emulator).
14. **[z.ai — manage API key / subscription](https://z.ai/manage-apikey/subscription)** — Z.ai (Zhipu, GLM-4.6 itp. chińskie modele). Zarządzanie API key.
15. **[nvidia/personaplex-7b-v1 — Hugging Face](https://huggingface.co/nvidia/personaplex-7b-v1)** — NVIDIA PersonaPlex 7B, model **konwersacyjny audio-to-audio** oparty na architekturze Moshi. Generuje natural low-latency speech z persistent persona (voice + text prompt). Idealny pod TTS/STS w Memphis.
16. **[Developer-Y/cs-video-courses](https://github.com/Developer-Y/cs-video-courses)** — gigantyczna lista darmowych CS courses z video (Stanford, MIT, etc.).
17. **[arcee-ai (Hugging Face org)](https://huggingface.co/arcee-ai)** — Arcee AI, pioneer **Small Language Models (SLM)** — open-weight modele "world-class performance per parameter". Mają np. Arcee-VyLinh 3B (vietnamski). Pasuje do Memphis local-LLM invariant.
18. **[The Agent Skills Directory — skills.sh](https://skills.sh/)** — katalog **Claude Code Agent Skills** (skill = `~/.claude/skills/<name>/SKILL.md` + materiały). Zob. też: [docs Anthropic](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview), [232+ community skills (alirezarezvani)](https://github.com/alirezarezvani/claude-skills).
19. **[Innovations Hub Foundation — Polish startup ecosystem](https://www.innovationshub.pl/en/)** — fundacja, akcelerator/inkubator polskich startupów. Mapa polskiego ecosystemu, programy inkubacyjne.
20. **[paoloanzn/free-code](https://github.com/paoloanzn/free-code)** — "free build of Claude Code" — telemetria usunięta, security guardrails ściągnięte, eksperymentalne fichy włączone. **UWAGA: parent repo migruje ownership, repo zablokowane.** Treść kontrowersyjna (modyfikacja klienta Anthropic).
21. **[TheTom/turboquant_plus](https://github.com/TheTom/turboquant_plus)** — TurboQuant Plus, rozszerzenie do `mlx-lm` (Apple MLX) — kwantyzacja LLMów do uruchamiania na Apple Silicon. 2.8k stars, świeże (1 tydzień). Instalacja: `pip install git+https://github.com/TheTom/mlx.git@feature/turboquant-plus`.
22. **[ultraworkers/claw-code](https://github.com/ultraworkers/claw-code)** — Rust port Codex (`oh-my-codex` based). 100K stars szybko. **Obecnie zablokowane (ownership transfer)** — mirror: `claw-code-parity`.
23. **[danveloper/flash-moe](https://github.com/danveloper/flash-moe)** — uruchamianie dużego MoE modelu na słabym laptopie. Pasuje do PC3 / Memphis low-resource.
24. **[arXiv 2603.21852v2 — All elementary functions from a single binary operator](https://www.alphaxiv.org/abs/2603.21852v2)** — paper: jeden operator `eml(x,y) = exp(x) - ln(y)` wystarcza do wyrażenia **wszystkich** elementarnych funkcji (sin, cos, sqrt, log...). Continuous-math odpowiednik NAND z digital logic. Fascynujące matematycznie.
25. **[mSzyfr APK (APKPure)](https://apkpure.com/mszyfr/pl.nask.mszyfr)** — `pl.nask.mszyfr`, polski Matrix rządowy (NASK + MC). Backup APK.
26. **[ResearAI/DeepScientist](https://github.com/ResearAI/DeepScientist)** — agent AI do autonomous scientific research. Push frontiers, etc.
27. **[memvid/memvid](https://github.com/memvid/memvid)** — **memory layer dla AI Agents**. Single-file serverless, zastępuje complex RAG pipeline. Konkurent dla Memphis memory chains — warto sprawdzić ich approach.
28. **[alibaba/page-agent](https://github.com/alibaba/page-agent)** — JavaScript in-page GUI agent. Steruje web UI naturalnym językiem.
29. **[Kuberwastaken/claurst](https://github.com/Kuberwastaken/claurst)** — Claude Code w Rust ("favorite terminal coding agent now in Rust"). Inny niż `claw-code` z #22.
30. **[Liquid4All/cookbook — audio-car-cockpit](https://github.com/Liquid4All/cookbook/tree/main/examples/audio-car-cockpit)** — Liquid AI demo voice-controlled car cockpit łączący **LFM2.5-Audio-1.5B** (TTS+STT) z **LFM2-1.2B-Tool** (function calling). Wzorzec dla Memphis voice workflow. Cookbook ma też LocalCowork, plane-booking agent itp.
31. **[shiyu-coder/Kronos](https://github.com/shiyu-coder/Kronos)** — Kronos, Foundation Model dla **języka rynków finansowych** (financial time-series jako "język").
32. **[0xSojalSec/airllm](https://github.com/0xSojalSec/airllm)** — odpalanie 405B LLMs na 8GB VRAM (layer-by-layer offloading). Pasuje do PC3.
33. **[hotheadhacker/no-as-a-service](https://github.com/hotheadhacker/no-as-a-service)** — joke API: zwraca losowy powód odmowy. Easter egg.
34. **[BasedHardware/omi](https://github.com/BasedHardware/omi)** — open-source AI wearable, "widzi twój ekran, słyszy rozmowy, mówi co robić". Hardware + software.
35. **[Brax Technologies — secure & private mobile (BraX3)](https://www.braxtech.net/)** — **BraX3**, smartphone z naciskiem na prywatność: open-source stack, brak forced accounts, brak telemetrii, własny ekosystem zamiast Google/Apple. Indiegogo ([crowdfunding link](https://www.indiegogo.com/en/projects/braxtechnologies/brax3-the-most-privacy-friendly-smartphone)). Kandydat na hardware dla Memphis mobile companion.
36. **[Git-on-my-level/codex-autorunner](https://github.com/Git-on-my-level/codex-autorunner)** — autorunner do Codex / GPT (loop runner).
37. **[Daniel Kessler — LinkedIn](https://www.linkedin.com/in/daniel-kessler-4b7a5150/)** — kontakt LinkedIn (kim jest? networking?).
38. **[Platforma Zakupowa — Create account](https://platformazakupowa.pl/register/)** — polska platforma zakupowa (zamówienia publiczne).
39. **[Portal Dostępowy ezamowienia.gov.pl](https://ezamowienia.gov.pl/en/)** — oficjalny portal e-zamówień publicznych RP.
40. **[SPIN — Małopolskie Centra Transferu Wiedzy (dla kogo)](https://www.spin.malopolska.pl/index.php/dla-kogo)** — projekt SPIN (Fundusze Europejskie dla Małopolski 2021–2027): wsparcie mikro/MŚP w opracowywaniu **innowacyjnych rozwiązań** przez transfer wiedzy z uczelni. **Pasuje do Memphis jako kandydat na finansowanie.**
41. **[Akces NCBR](https://akces-ncbr.pl/)** — Akces NCBR, **rynkowe ramię NCBR**. Programy akceleracyjne dla startupów.
42. **[Akces NCBR — HPN Impakt regulamin](https://akces-ncbr.pl/dokumenty-do-pobrania-hpn-impakt/regulamin-1.html)** — **HPN Impakt** (świeżo ogłoszony, ~2-3 tyg temu): nabór dla **technologii impaktowych** o potencjale komercjalizacyjnym, oparte o R&D, TRL 3-8. **Memphis kwalifikuje się.**
43. **[warproxxx/poly_data](https://github.com/warproxxx/poly_data)** — Polymarket data retriever (markets, orders, trades).

---

### 📁 Bookmarks (root)

44. **[🧙 Memphis HUD — localhost:3848](http://localhost:3848/)** — lokalny HUD Memphis (control UI?). Shortcut do panelu.

---

### 📁 (no folder, top level)

45. **[Kalendarz Google](https://calendar.google.com/calendar/u/0/r?pli=1)** — Google Calendar (`elathoxu@gmail.com`).
46. **[Mayan Calendar](https://mayancalendar.eu/)** — kalendarz Majów online.
47. **[CoinPaprika](https://coinpaprika.com/)** — research crypto, top 100, market caps.

---

### 📁 29.11

Folder z 29 listopada (chyba research session) — mix duchowy/słowiański/finansowy/spirit-tech.

48. **[Google Translate — "POP A PERK FOR CHARLIE KIRK"](https://translate.google.com/?sl=en&tl=pl&text=POP%20A%20PERK%20FOR%20CHARLIE%20KIRK&op=translate)** — tłumaczenie EN→PL.
49. **[YouTube — Itzhak Bentov "From Atom To Cosmos"](https://www.youtube.com/watch?v=YYUn1w4hJqo&list=PLRmdzuYAdRInNaFjJ4tEAQhk1F0FNxXqt)** — Itzhak Bentov, izraelski naukowiec/mistyk, twórca koncepcji "stalking the wild pendulum". Excerpt z lekcji.
50. **[Na tropie Słowian — blog](https://natropieslowian.blogspot.com/)** — Efi Tylka, blog o Słowianach (etnografia, genetyka, archeologia, mitologia, lingwistyka). Polska słowianowierczość.
51. **[Y Combinator — Series A Term Sheet Template](https://www.ycombinator.com/series_a_term_sheet)** — YC otwarty template term sheetu dla rundy Series A. Standard branżowy.
52. **[DPI Archive — login](https://www.dpiarchive.com/#/login?redirect=%2Fsubcategory%2Fdocuments%3FidSubcategory%3D10004)** — **Disclosure Project Intelligence Archive** (Dr. Steven Greer): 33 lata zdigitalizowanych dokumentów/zeznań nt. UFO/UAP, ujawnionych w maju 2024. FREE access (po loginie).
53. **[Słowianie i Słowianowierstwo — Co wiemy o wierzeniach Słowian (Rafał Merski)](https://slowianowierstwo.wordpress.com/2023/10/14/co-wiemy-o-wierzeniach-slowian-i-jak-je-badac-rafal-merski/)** — artykuł nt. badania wierzeń Słowian.
54. **[Słowiański zegar](https://slowianowierstwo.wordpress.com/polecane-strony/slowianskizegar/)** — interpretacje słowiańskiego zegara/cyklu.
55. **[SaveWisdom.org](https://savewisdom.org/)** — projekt archiwizacyjny "**all human wisdom is worth saving**". Każdy nagrywa odpowiedzi na 1000 pytań Voice Memo i archiwizuje. Niska technologia, idea: zachować mądrość ludzi przed śmiercią. **Brzmi jak naturalny use-case dla Memphis "soul/journal" chains** — local-first wisdom preservation.
56. **[Anselm Pi Rambla](https://www.pirambla.com/index.html)** — kataloński archeolog, **odkrywca 2-km tunelu pod Cuzco** (2000), eksplorator pre-inkaskich struktur (Chinkana, Sphinx Bosnia). Pi Rambla Heritage Foundation. ([LinkedIn](https://www.linkedin.com/in/anselm-pi-rambla-8260792a5/))
57. **[Google — fotoserwis Anny Zapolskiej 42 Kraków](https://www.google.com/search?q=fotoserwis+anny+zapolskiej+42+krakow)** — search lokalnego fotoserwisu.
58. **[The Earth Guard — Astral Travel Training Course](https://www.theearthguard.org/shop/p/astral-travel-training-course)** — kurs astralnej projekcji (1-month trial $295-333). Prowadzący: Alobar. Strona oferuje też "demon hunting" trainings, supplements, minerals — ezoteryka.
59. **[Google — synology](https://www.google.com/search?q=synology)** — search "synology" (NAS).
60. **[Dr Renata Zarzycka — Coaching, Konsultacje, Publikacje](https://renatazarzycka.com.pl/)** — autorka >100 książek, "Specjalista Medycyny Naturalnej". Coaching, konsultacje (tel +48 509 970 880).
61. **[Tokamak Energy — Seeing plasma in colour: ST40 imaging](https://tokamakenergy.com/2025/10/15/seeing-plasma-in-colour-new-imaging-from-st40/)** — Tokamak Energy (UK fusion startup), nowe imaging plazmy z reaktora **ST40** (kompaktowy spherical tokamak). Październik 2025.
62. **[Grand Theft World (Rumble livestreams)](https://rumble.com/c/grandtheftworldpodcast/livestreams?e9s=src_v1_cbl)** — podcast Richarda Grove'a (od 2020, IMDb), **alt-media**, geopolityka/historia/konspiracje. Live na Rumble/Odysee/Rokfin/YouTube/Twitch.

---

## Dodatkowe obserwacje

- **3 zakładki workflow/main warto wyczyścić:** Gmail verify (#1, prawdopodobnie wygasł), 2 sesje LLM (#6 ChatGPT, #7 Claude — historia chatu, czy jeszcze potrzebna?).
- **Polskie programy finansowania** (#40, #41, #42) — **realny match dla Memphis** (HPN Impakt: TRL 3-8, technologie impaktowe). Warto zaaplikować.
- **AI workflow stack** ułożony: AIMLAPI (#10), Mistral admin/console (#11/#12), Z.ai (#14), Claude/ChatGPT/Grok/Perplexity (#6/#7/#8/#9). Multi-provider, zgodne z Memphis cascade philosophy.
- **2 repo "claude-code w Rust"** (#22 claw-code, #29 claurst) + 1 zmodyfikowany klient (#20 free-code). Trzy approach do tego samego problemu — warto je porównać jeśli kiedykolwiek migracja z TS.
- **Memphis-relevant repos:** memvid (#27 — alternatywa memory layer), Liquid4All cookbook (#30 — voice agent wzorzec), arcee-ai (#17 — SLM dla local LLM), airllm (#32 — LLM na słabym hw), turboquant (#21 — kwantyzacja).
- **Folder 29.11** wyraźnie z innej fazy (duchowo-eksploracyjna) — może warto go zarchiwizować jeśli nie wraca do tematu.

---

_Wygenerowane przez Jurka, 2026-04-18, z eksportu zakładek (62 entries) + planu `~/memphis/review.md` (cuddly-plotting-backus)._

---

## CZĘŚĆ III — Konsolidacja + zaklepanie decyzji + architektura ludzka

> Dodane po naradzie planistycznej, w odpowiedzi na feedback z Części I i z
> uwzględnieniem zakładek z Części II. Jeden punkt wejścia dla człowieka
> zaczynającego kampanię po wstaniu od stołu.

### A — Zaklepanie 6 luk (lock-in)

Część I identyfikuje 6 gaps. Tu zamykam je konkretem — każda luka dostaje
decyzję + mechanikę, nie dalsze rozważania.

#### Luka 1 → Frontend + runtime model

**Zamknięte: React 18 + shadcn/ui + react-hook-form + zod** jako stack GUI.
**Zamknięte: background daemon (systemd --user) + GUI on-demand + systray**
jako runtime model.

Powody po skrócie:
- shadcn to state-of-art dla estetyki Zed/VSCode, react-hook-form + zod
  idealnie pasuje jako konsument L3 Blueprint schema
- React ma największą community = najszybszy turnaround AI-assisted development
- Background daemon zgadza się z "always-on sovereign AI" — bez tego brak
  notyfikacji, federation sync zrywany przy zamknięciu okna
- Wzorzec Tailscale/Docker-Desktop/Syncthing jest zrozumiały dla userów

Odrzucone: Svelte (mniejsze wsparcie dla schema-driven forms), Leptos
(dev velocity zbyt niska dla solo), single-process GUI (zrywa invariant
always-on).

#### Luka 2 → Phase 3 spike pre-gate

**Zamknięte: nowa Phase 3-spike przed Phase 3a**, 1 tydzień TIMEBOX.

| Dzień | Zadanie |
| --- | --- |
| D1–D2 | Fix OR remove `ml-vm` z workspace'u. Jeśli fix > 2 dni → rip out. |
| D3–D4 | Prototype ml-p2p → sync-manager adapter, proof-of-concept. |
| D5–D6 | Prototype virtualized clock (Luka 4) + determinism tracing, record/replay roundtrip. |
| D7 | Write 100-line ML sample Agora offer, verify replay deterministic. |

**Decyzja po spike'u:**
- Wszystkie 4 kroki zielone → proceed Phase 3b jak w planie (memphis-ml jako contract language)
- Jakiekolwiek > 2× budget → **abort ML integration**, offers jako JSON schema + endpoint URL (Option A w issue #156)

Nowe GH issue: **#159 `phase-3-spike`**.

#### Luka 3 → Dual-chain atomicity (WAL + crash-recovery)

**Zamknięte: `withAppendLockAcrossChains` rozszerzone o WAL sentinel pattern** (inspired by ext4 rename journaling).

```
pinTrustAnchor(did, label):
  1. Acquire cross-chain lock [trust.chain, trusted.chain]
  2. Write .pair-in-progress sentinel: { op, did, pid, at }
  3. fsync(sentinel)                          ← durable przed zmianami
  4. Write tmp files dla obu chains
  5. fsync(tmp_trust); fsync(tmp_trusted)    ← durable contents
  6. rename(tmp_trust → trust.chain/X.json)
  7. rename(tmp_trusted → trusted.chain/X.json)
  8. fsync(trust.chain/); fsync(trusted.chain/)  ← durable renames
  9. unlink(sentinel)                          ← success marker
 10. Release lock

Startup recovery scan:
  for each .pair-in-progress sentinel:
    - both target blocks present    → delete sentinel (clean)
    - neither present               → delete sentinel (clean, caller retries)
    - only one chain has the block  → truncate partial, delete sentinel (rollback)
```

**Update Phase T (#151)** — dodać do Function Evaluation nową sekcję
**"Crash recovery"** z I5: *Restart po kill -9 między fsync → recovery
scan przywraca spójność; `listCurrentTrustAnchors()` i `trusted.chain`
zgodne.*

**Nowy test (regresja):** `kill -9` po kroku 6, restart, `listCurrentTrustAnchors`
nie widzi did'a, `trusted.chain` też nie — albo obie widzą. Nigdy jedna+druga.

#### Luka 4 → Virtualized clock dla ML contracts

**Zamknięte: Virtualized I/O primitives** w `ml-core` — wszystkie
non-deterministic sources dostępne TYLKO przez injected providers.

Sources do wirtualizacji:
- `Clock::now_ms()` zamiast `Date.now()`/`SystemTime::now()`
- `Rng::bytes(n)` zamiast `Math.random()`/`thread_rng()`
- `Sensor::read()` (już tak się dzieje w ml-hal)
- `Llm::complete(prompt)` — jego odpowiedź też journalled
- `HttpFetch::get(url)` — response bytes journalled

```rust
pub trait MLEnv {
  fn clock_now(&mut self) -> u64;       // journalled
  fn rng_bytes(&mut self, n: usize) -> Vec<u8>;  // journalled
  fn llm_complete(&mut self, prompt: &str) -> String;  // journalled
  // etc.
}

struct RecordingEnv { clock: SystemClock, journal: Journal }
struct ReplayEnv   { journal: Journal }  // reads recorded values
```

**Update Phase 3b (#156) prereq section** — dodać punkt:
*"All non-deterministic access goes via `MLEnv` trait; direct OS time/RNG/I/O
rejected przy AST validation time."*

#### Luka 5 → Phase 4.5 adversarial simulation

**Zamknięte: nowa Phase 4.5 pomiędzy #157 i #158**. Phase 5 Marketplace UX
nie startuje przed zielonym 4.5.

Obowiązkowe scenariusze ataku (symulacja na testnecie):

| Atak | Oczekiwane zachowanie | Warunek zielony |
| --- | --- | --- |
| **Sybil swarm** — 1000 atakujących DIDs | Oferty niewidoczne dla uczciwego operatora bez attestation path lub stake | `discoverOffers()` filter dla operatora X zwraca 0 ofert sybilowego kręgu |
| **Wash trading** — fake contracts w ramach kliki | Reputation nie nabiera masy bo weighting × attestation-distance zeruje | `reputationOf(sybil) → { score, confidence: low }` |
| **Slash-vote collusion** — attacker + N kumpli próbują slash innocent | selectArbiters PRF z reputation-weighted pool → attacker nie gwarantuje wyboru swojej grupy | > 90% prób slash-vote collusion kończy się odmową wykonania slash |
| **Attestation cycle** — A→B→C→A loop | BFS visited-set terminuje cykl → distance = Infinity poza tree | `trustPathFromAnchor` zwraca `Infinity` dla loop'a |
| **Stake-grief** — attacker lock'uje stake i prowokuje slash ofiary | Arbiter k-of-n majority → single attacker nie wygrywa głosowania | > 95% prób stake-grief kończy się release dla ofiary |

**Deliverable:** `docs/AGORA-ATTACKS.md` + runnable simulator w `tests/sim/`
+ przebieg każdego scenariusza na testnecie z reportem.

**Nowy GH issue: #160 `phase-4.5-agora-adversarial-sim`.**

#### Luka 6 → Vault-unlock lifecycle w Tauri

**Zamknięte: 3-tier auth model** z jawną state-machine.

| Tier | Kiedy działa | Auto-lock triggers |
| --- | --- | --- |
| **Session auth** (15 min idle TTL) | chat, read chains, list peers, run safe tools | idle > 15 min · suspend/sleep · explicit lock button |
| **Fresh auth** (per-op, never cached) | stake.lock, stake.slash, wallet.unlock, wallet.send, trust.revoke, trust.anchor.pin, tier3.elevate, self-modify.commit | każda taka op prompt'uje niezależnie od session state |
| **Recovery auth** | passphrase-forgot path | Q&A recovery answer, nie session |

**Mockup modal fresh auth:**
```
┌──────────────────────────────────────────────────┐
│  🔐 Fresh auth required for: stake.lock          │
│  ─────────────────────────────────────────────   │
│  Locking 500 sats as escrow for:                 │
│    "translate PL→EN" (did:mph:bob...)            │
│                                                  │
│  [ Why? ] Financial actions always require       │
│    vault-2FA — even when GUI session is unlocked │
│                                                  │
│  Passphrase:        [______________]             │
│  Recovery answer:   [______________]             │
│                                                  │
│  [  Cancel  ]             [ Approve & Sign ]     │
└──────────────────────────────────────────────────┘
```

**Update Phase G (#152)** — dodać do Function Evaluation nową sekcję
**"Operator auth model"** jako odrębną funkcję ze schematem stanu.

---

### B — Architektura — cztery szkice

Jedna architektura, cztery widoki. Każdy odpowiada na inne pytanie.

#### Widok 1 — Stos warstwowy ("od czego zależy co")

```
╔═══════════════════════════════════════════════════════════════╗
║  L7  EXTERNAL — hardware · payment · MCP clients out          ║
╟───────────────────────────────────────────────────────────────╢
║  L6  FEDERATION — private sync · public Agora                  ║
╟───────────────────────────────────────────────────────────────╢
║  L5  SURFACES — TUI · GUI · Telegram · custom app · MCP server║
╟───────────────────────────────────────────────────────────────╢
║  L4  POLICY — tiery · autonomy · surface policy · audit        ║
╟───────────────────────────────────────────────────────────────╢
║  L3  REGISTRIES ← glue: tools · skills · commands · blueprints║
╟───────────────────────────────────────────────────────────────╢
║  L2  RUNTIME — gateway · providers · memory · sync · breaker  ║
╟───────────────────────────────────────────────────────────────╢
║  L1  STORAGE — chains (journal/soul/trust/trusted/agora.*)    ║
╟───────────────────────────────────────────────────────────────╢
║  L0  IDENTITY — DID · ed25519 · Argon2id · 2FA                ║
╚═══════════════════════════════════════════════════════════════╝
```

Reguła: warstwa N woła tylko N-1, …, 0. Nigdy N+k.

#### Widok 2 — Data flow ("jak żyje wywołanie capability")

```
 operator (speech / keyboard / bot / http)
        │
        ▼
   [L5 surface] ── iteruje L3 registries ──┐
        │                                   │
        │ POST /v1/capability/:k/:id/invoke │
        ▼                                   │
   [L4 policy] ── deny? → 403 audit-logged──┤
        │                                   │
        │ allow                             │
        ▼                                   │
   [L3 registry executor]                   │
        │                                   │
        │ dispatch descriptor.handler       │
        ▼                                   │
   [L2 runtime services]                    │
        │                                   │
        │ LLM / MCP tool / sync call        │
        ▼                                   │
   [L1 storage] ── append signed block ─────┘
        │
        ▼
   observable signal do surface (re-query registry + status)
```

**Inwariantka:** surface re-czyta stan, nie trzyma go. Restart surface'u
bez utraty stanu.

#### Widok 3 — Topologia zaufania ("kto komu wierzy")

```
                  ┌──────────────────────────────┐
                  │    AGORA L6 public tier      │
                  │  4 warstwy: DID/WoT/stake/rep│
                  │  ranked filter przed ekspozycją
                  └──────────────┬───────────────┘
                                 │
                                 │ discoverOffers
                                 │ (below threshold → hidden)
                                 ▼
                  ┌──────────────────────────────┐
                  │  MÓJ OPERATOR TRUST CORE     │
                  │                              │
                  │  pinned anchors (IRL):       │
                  │   • marcin, alice            │
                  │                              │
                  │  attested 1-hop:             │
                  │   • bob (via marcin)         │
                  │   • carol (via alice)        │
                  │                              │
                  │  attested 2-hop:             │
                  │   • dave (via bob)           │
                  │                              │
                  │  revoked (kept in trusted.):│
                  │   • spam-1                   │
                  └──────────┬─────┬─────────────┘
                             │     │
                   trust.chain   trusted.chain
                   (current)     (forensic, append-only)
```

**Inwariantka:** `listCurrentTrustAnchors()` ⊆ `getTrustHistory()`. Nigdy
nie znika z historii.

#### Widok 4 — Sequence "add a tool, see everywhere"

```
Dev pisze:
  src/mcp/tools/ghunt.ts
  
  export const ghuntTool: ToolDescriptor = {
    id: 'memphis_osint_ghunt',
    title: 'GHunt — investigate Google account',
    description: 'Query public data for a Google email/ID',
    schema: z.object({ target: z.string().email() }),
    tier: 3,
    surface_allowlist: ['tui', 'gui', 'mcp-external'],  // NO Telegram
    handler: runGhunt,
    llm_guidance: 'Use when operator asks about a Google account',
  };

Dev rejestruje raz:
  toolRegistry.register(ghuntTool);

Co się stało automatycznie:

  TUI         → nowy row w "Tools" catalog
  GUI         → nowa karta w Tools panel (form gen z zod schema)
  Telegram    → NIE widzi (surface_allowlist filtruje)
  CLI         → memphis tool run memphis_osint_ghunt --target=x@y.com
  MCP server  → external LLM widzi jako MCP tool
  Gateway     → POST /v1/tool/memphis_osint_ghunt/invoke
  Custom app  → konsumuje ten sam endpoint
```

**To jest L3 registry magic.** Zero ręcznej integracji per surface.

---

### C — Stack inspiracji zmapowany na warstwy

Zakładki z Części II uporządkowane według roli w architekturze.

#### L2 — Local LLM serving (provider cascade)

| Zakładka | Rola dla Memphis |
| --- | --- |
| #15 **NVIDIA PersonaPlex 7B** (audio-to-audio, Moshi arch) | TTS/STT stack dla voice surface'u (Phase G+). Low-latency speech z persistent persona. |
| #17 **arcee-ai org** (Small Language Models) | "Small-by-default" ethos — kandydat na lokalne modele gdy user nie chce Ollama/30GB |
| #21 **TheTom/turboquant_plus** (MLX quantization) | Apple Silicon users — kwantyzacja dla lokalnego Memphis na Macu |
| #23 **danveloper/flash-moe** (MoE na słabym laptopie) | PC3 / low-resource fallback ścieżka |
| #32 **airllm** (405B na 8GB VRAM) | Extreme low-resource dla power-userów z 405B aspiracjami |
| #33 (tylko jako info) | joke easter egg, nie produkcja |

**Decyzja stack'owa:** Ollama jako primary. Phase G dodać `WebGPUProviderAdapter`
inspirowany #30 bonsai-webgpu (z Części I linków), dla zero-install
fallback'u w GUI. Arcee-AI jako default small-model jeśli Memphis kiedyś
ships own-model distribution.

#### L3 — Capability inspiracje (tools + skills)

| Zakładka | Rola |
| --- | --- |
| #18 **skills.sh** (Claude Code Agent Skills catalog) | Reference dla Memphis skill registry design + Agora Phase 5 marketplace UX |
| #20 **paoloanzn/free-code** | Reference for "unrestricted coding assistant" — ale NIE adoptujemy bo telemetria-less + security-stripped = anti-pattern dla sovereign |
| #22 **claw-code** / #29 **claurst** (Claude Code w Rust) | Jeśli kiedyś migracja TS→Rust dla Memphis core, zobaczyć ich approach |
| #30 **Liquid4All cookbook — audio-car-cockpit** | Wzorzec voice-workflow: STT + function-calling LLM + TTS. Model do Phase G voice surface. |
| #36 **Git-on-my-level/codex-autorunner** | Reference dla scheduler-driven autonomous tool chains |

**Decyzja:** L3 registry design bazuje na skills.sh conceptually (skill = declarative folder z SKILL.md + metadata). Liquid4All cockbook daje wzorzec dla voice surface (Phase G v2).

#### L1 — Memory infrastructure

| Zakładka | Rola |
| --- | --- |
| #27 **memvid/memvid** (memory layer for AI agents, single-file serverless) | **Konkurent Memphis chains.** Warto przeanalizować ich approach, ale NIE integrujemy — Memphis ma własny signed-block chain design z audit-trail, memvid jest bardziej RAG-oriented |

**Decyzja:** Memphis trzyma się signed-chain model. Memvid jako "warto
wiedzieć czego nie robić albo co robić inaczej".

#### L5 — Surface patterns

| Zakładka | Rola |
| --- | --- |
| #28 **alibaba/page-agent** (JS in-page GUI agent) | Reference dla potencjalnego browser-extension surface Memphis v3 (odroczone) |
| #34 **BasedHardware/omi** (open-source AI wearable) | Hardware companion Memphis v3 (odroczone, ale ekosystemowo interesujące) |
| #35 **Brax BraX3** (privacy-friendly smartphone) | Target hardware dla Memphis mobile companion v3 |

**Decyzja:** surface'y v1 = TUI + GUI + Telegram + CLI + MCP + custom-app.
Surface'y v2 (post-v1.5.0) = voice (Phase G+ z Liquid4All wzorcem), browser-ext.
Surface'y v3 (2027+) = wearable, mobile-as-companion.

#### L7 — External integration i ecosystem research

| Zakładka | Rola |
| --- | --- |
| #43 **warproxxx/poly_data** (Polymarket data) | Future MCP tool dla market-data retrieval — Phase 3 Agora context, albo standalone tool w Phase G+ |
| #26 **ResearAI/DeepScientist** | Reference dla potencjalnego "research skill" w Phase G+ |
| #31 **Kronos** (foundation model dla market data) | Inspired dla sektorowych skills — finance-aware skill |

#### Polski kontekst ekosystemowy

| Zakładka | Rola |
| --- | --- |
| #19 **Innovations Hub Foundation** | Lokalny ecosystem — Memphis jako europejska suwerenna alternatywa, framing dla grantów |
| #25 **mSzyfr APK** (NASK polski Matrix rządowy) | Reference dla government-grade security standardów |
| #40 **SPIN Małopolskie Centra Transferu Wiedzy** | Finansowanie: transfer wiedzy z uczelni |
| #41 **Akces NCBR** | Akceleracja startupów |
| #42 **Akces NCBR HPN Impakt** (świeżo ogłoszony) | **KRYTYCZNE** — nabór dla technologii impaktowych TRL 3-8. Memphis kwalifikuje się. |

**Decyzja strategiczna:** **HPN Impakt application** jako równoległy track
obok technical development. Aplikacja wymaga opisu TRL 3-8 + komercjalizacji
— Memphis v1.4.0 (po Horizon 1) jest TRL 4-5 (demonstrable in lab), v1.5.0
Desktop Preview (po Horizon 2) jest TRL 6 (system/subsystem model demonstration
in relevant environment). Docelowo v2.0.0 z Agorą = TRL 7-8.

---

### D — Zrewidowany roadmap (z feedback #6 + zakładki)

Horizon 1 (2-3 tyg): **Phase L** + **L3 Registry MVP** (nowe, wymagane
przez Add-Tool-Seen-Everywhere) + **Phase P** + **Phase T (z WAL)**. Ship
`v1.4.0`.

Horizon 2 (3-4 tyg): **Phase G minimal** (React+shadcn, chat view + status
bar + settings + 3-tier vault auth) + **WebGPU fallback provider** (inspiracja
bonsai-webgpu) + **starter custom app example**. Ship `v1.5.0 Desktop Preview`.

**Decision gate:** 5-10 userów przez miesiąc → Agora go/no-go.

Horizon 3 (conditional, jeśli Agora green): **Phase 0** design doc →
**Phase 3-spike** (#159, TIMEBOX 1wk) → **Phase 1** attestations → **Phase 2**
reviews → **Phase 3** stake + (ML OR JSON schema offers) → **Phase 4** discovery
→ **Phase 4.5** adversarial sim (#160) → **Phase 5** marketplace UX.

Równolegle nietechniczny track: **HPN Impakt application** (Część II #42) —
przygotowanie aplikacji grantowej po Horizon 1 zakończonym. Partnerstwo
wymaga demonstrable TRL, Horizon 1 daje to.

---

### E — Regulamin R1–R11 (non-negotiable)

1. **R1** — warstwa N woła tylko N-1, …, 0
2. **R2** — L5 surface nie trzyma state aplikacji (stan w L1/L2)
3. **R3** — L3 descriptory deklaratywne, jeden plik = cała info
4. **R4** — L4 policy evaluator pure function, testable
5. **R5** — każdy nowy `MEMPHIS_*` env → Blueprint (po Phase B)
6. **R6** — każda operator-op → signed block
7. **R7** — każda decyzja finansowa → vault-2FA modal + fresh auth
8. **R8** — Local-LLM fallback unconditional
9. **R9** — Atomowe cross-chain writes mają WAL sentinel + recovery scan (Luka 3)
10. **R10** — ML contracts mają non-deterministic sources tylko przez virtualizowane primitives (Luka 4)
11. **R11** — Agora Phase 5 nie startuje bez zielonego Phase 4.5 (Luka 5)

---

### F — Do zrobienia TEGO tygodnia (action items)

Status update 2026-04-19 (po nadradzie + sesji nieskazitelnego działania):

- [~] **Commit 3 docs do main** — IN PROGRESS jako DRAFT PR #159 (`docs/roboczy-roadmap-2026-04-18`); merge po finalizacji review (zob. F.7+F.8 niżej).
- [x] **Utworzyć GH issues phase-3-spike + phase-4.5-adversarial-sim** — DONE jako #160 + #161 (renumeracja: planowane numery #159/#160 zostały zajęte przez DRAFT docs PR).
- [ ] **Update existing issues**:
  - #151 Phase T — dodać WAL sentinel + crash-recovery (R9)
  - #152 Phase G — dodać 3-tier auth model jako function eval (Luka 6)
  - #156 Phase 3 — dodać virtualized clock jako prereq (R10)
  - #158 Phase 5 — dodać dependency na #161 (R11)
- [x] **Start Phase L** (#149) — DONE jako PR #162 (`feat/phase-L-local-llm-invariant`). Lekki gate w `tests/integration/offline-invariant.test.ts` + ciężki nightly w `.github/workflows/offline-acceptance.yml` (rc-drill.sh). Plus defensive fix `resolveSqlitePath` (handle undefined DATABASE_URL).
- [~] **Start L3 Registry MVP** — REKLASYFIKACJA: ToolRegistry **już częściowo istnieje** w `src/gateway/tool-registry.ts:22` (37 toolów zarejestrowanych metadata). Z "3 dni nowego systemu" → "1-2 dni incremental polish: dodać `inputSchema?: z.ZodSchema` do `ToolMeta` + pilot 5 tools". Kategoria zmieniona z PRAWA na LEWA noga.
- [ ] **Research HPN Impakt application wymagania** (równolegle) — czytanie regulaminu z zakładki #42 — czeka na PDF od operatora.

### F.7 NEW — Audit-trail hygiene (DONE 2026-04-19)

Zamknąć security issues OPEN mimo merged-fix. Status: **DONE 2026-04-19**.

- [x] #138 Dashboard XSS escape — fixed in PR #141 (commit 7e8d6b6)
- [x] #139 MCP transport loopback fail-closed — fixed in PR #141
- [x] #140 Manifest shellQuote — fixed in PR #141
- [x] #143 Dashboard /api/data Bearer token — fixed in PR #146 (commit 543b212)
- [x] #144 two_factor.rs Result return — fixed in PR #146
- [x] #145 Vault rotation fsync — fixed in PR #146

### F.8 NEW — Audyt warstwowy uzupełnić (DONE 2026-04-19)

`MEMPHIS_ARCHITECTURE_LAYERS.md` brakowało faktycznych komponentów. Status: **DONE 2026-04-19** w tym samym PR #159.

- [x] L0: dopisana pełna lista 11 plików `src/security/` + 5 plików Rust
- [x] L2: dopisane 7 brakujących katalogów `src/` (decision/reflection/cognitive/resilience/federation/cache/agent) + 6 z `src/infra/`
- [x] L5: dopisane 4 surface-relevant adaptery (bridges/app/voice/channels)
- [x] Dodana sekcja "Crates Rust — kompletny inwentarz" z 7 crates (memphis-case-index, memphis-embed, memphis-operator wymienione po raz pierwszy)

### F.9 NEW — Phase A3 sanitizers (DONE 2026-04-19)

Defensive instrumentation deferred z security scan sprint. Status: **DONE 2026-04-19** jako PR #163 (`feat/phase-A3-rust-sanitizers`).

- [x] AddressSanitizer na `memphis-vault` (Argon2id, ed25519, vault crypto)
- [x] UBSan na `memphis-core` (chain logic, signatures)
- [x] ThreadSanitizer na `memphis-core` (append-lock concurrency)
- [x] Workflow `.github/workflows/rust-sanitizers.yml` — workflow_dispatch + Sundays 03:00 UTC

### F.10 NEW — Branch + repo hygiene (DONE 2026-04-19)

- [x] Sprzątnięto 17 lokalnych branchy (wszystkie merged) + 28 origin branchy. Origin obecnie: `main`, `docs/roboczy-roadmap-2026-04-18`, `release/0.3.0`, `release/0.3.1`, plus aktywne `feat/phase-L-local-llm-invariant`, `feat/phase-A3-rust-sanitizers`.

---

### G — Podsumowanie dla człowieka

**Co zrozumiałem po tej naradzie:**

1. **Architektura:** 7 warstw, 4 widoki, 11 reguł. Core = L3 registries
   jako glue między wszystkimi surface'ami. "Add once, seen everywhere".
2. **6 luk z feedback'u:** wszystkie zamknięte konkretami. Frontend = React+shadcn,
   runtime = background+tray, Phase 3 dostaje spike pre-gate, dual-chain
   dostaje WAL+recovery, ML dostaje virtualized clock, Agora dostaje Phase 4.5.
3. **Stack inspiracji:** 62 zakładki z Części II zmapowane. Używamy: Ollama primary,
   WebGPU fallback (bonsai), Arcee-AI jako small-model ethos, Liquid4All
   wzorzec dla voice. Nie używamy: free-code (anty-sovereign), memvid (inny
   design). HPN Impakt jako parallel grant track.
4. **Roadmap:** 3 horizony, gate'y decyzyjne po H1 i H2. Agora conditional.
5. **Kolejny ruch:** Commit docs → utworzyć issues 159/160 → update 151/152/156/158
   → start Phase L + L3 Registry MVP.

**Czego nie rozumiem albo chcę wyjaśnić z Tobą:**

1. Czy HPN Impakt application rzeczywiście chcesz ścigać równolegle, czy
   dopiero po Horizon 2 (bardziej solidna TRL evidence)?
2. Czy commit docs do main = PR z review innego człowieka, czy direct merge
   skoro to tylko docs?
3. Starter custom app example — ma być w tym repo jako `apps/examples/` czy
   osobne repo? (Monorepo policy sugeruje w tym repo).
4. **Czy AGENTS.md Synjar section** ląduje w `core-memphis` workspace synjar
   (jako część architektury runtime'u), czy zostaje jedynie w repo jako
   agent-only context? (Decyzja UX dla nowego agenta wchodzącego do repo
   pierwszy raz.)

**Kończę naradę. Siadamy do roboty.**

_Uzupełnienie Części III: 2026-04-18, post-merge #146, po feedback'u z Części I + bookmarks z Części II._
