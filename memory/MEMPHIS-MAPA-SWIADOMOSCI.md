# Memphis — Mapa Swiadomosci (2026-03-28)

Krotki snapshot po restarcie i przerwie w zasilaniu. Ten dokument ma dac rano szybki punkt wejscia bez ponownego czytania calego dumpa.

**Źródła wejściowe:**

- `memory/MEMPHIS-ARCHITECTURE-MAP-2026-03-27.md`
- `memory/MEMPHIS-TEAM-START-GUIDE.md`
- `memory/memphis-knowledge-synth-2026-03-27.md`
- bieżące liczniki `life.db` podane przez operatora

---

## Co Jest Stabilne

- Memphis ma 3 odrębne runtime paths:
  - `memphis serve` = TypeScript bootstrap + Fastify + opcjonalny Telegram
  - `memphis rust-tui` = pure Rust cockpit z `OperatorRuntime`, z opcjonalnym TS hostem po stdio JSON
  - `memphis mcp serve` = osobny MCP server, nie część `serve`
- CLI nie używa `commander`; parser jest własny, z ponad 60 flagami i dispatcherem w `src/infra/cli/`
- Fastify ma realnie szeroki surface, nie tylko `/api/status`; dokumenty wskazują 35+ routes
- Runtime provider layer to 7 providerów plus `DynamicRouter`, ale `DynamicRouter` nie siedzi w ścieżce HTTP
- Storage to kilka oddzielnych warstw, nie jedna baza:
  - `memphis.db`
  - `case-index.sqlite`
  - `embed/memphis.db`
  - append-only `chains/`
  - `soul-memory.json`
- Rust side jest rozbita na 7 crates: `core`, `vault`, `embed`, `case-index`, `operator`, `napi`, `tui`

---

## Aktualny Obraz Na Rano

- Najkrótszy poprawny model systemu:
  - TypeScript prowadzi bootstrap, HTTP, gatewaye, CLI i MCP server
  - Rust prowadzi operator runtime, vault, embeddings, case-index i TUI
  - TUI działa dwutorowo: native Rust path + host commands wykonywane przez TS po stdio JSON
- Najważniejsze fakty operacyjne:
  - `memphis serve` robi bootstrap w 16 krokach
  - `memphis rust-tui` nie jest cienkim frontendem do HTTP; to osobna ścieżka runtime
  - `memphis mcp serve` ma własną powierzchnię storage/approval i należy traktować go jako osobny proces
- Ostatnie liczniki `life.db` przekazane przez operatora:
  - `memphis_connections`: 62
  - `memphis_arch_summary`: 75
  - `corrections`: 9

---

## Known Drift

- Dokumenty i repo nie są w pełni zsynchronizowane:
  - `MEMPHIS-ARCHITECTURE-MAP-2026-03-27.md` podaje starsze liczniki `life.db` (`56` i `67`)
  - `MEMPHIS-TEAM-START-GUIDE.md` i mapa mówią o `14` MCP tools
  - `memphis-knowledge-synth-2026-03-27.md` mówi o `15` MCP tools
  - bieżący `src/gateway/tool-registry.ts` ma `13` narzędzi w registry
- Źródła mają też lokalne sprzeczności techniczne:
  - guide twierdzi, że `memphis-case-index` nie używa FTS5
  - knowledge synth opisuje `case-index.sqlite` jako FTS5 + structured columns
  - mapa zawiera oba typy twierdzeń w różnych sekcjach
- `MEMORY.md` nie występuje w tym repo, więc nie jest częścią dzisiejszego handoffu
- `MEMPHIS-TEAM-START-GUIDE.md` odwołuje się do `node life-queries.js`, ale taki helper nie jest obecny w repo

Wniosek: ten handoff jest curated snapshotem na start dnia, a nie pełną normalizacją wszystkich źródeł do stanu kodu linia po linii.

---

## Start Here Tomorrow

1. Potwierdzić kanoniczny count narzędzi, porównując `src/gateway/tool-registry.ts` i `src/mcp/server.ts`.
2. Zdecydować, czy `life.db` ma być rano traktowane jako source-of-truth dla dokumentacji operacyjnej.
3. Uzgodnić status `case-index`: FTS5 vs denormalized/indexed SQLite i poprawić jedną warstwę dokumentacji, nie wszystkie naraz.
4. Jeśli potrzebny jest codzienny snapshot, dodać repo-local helper do odczytu `life.db` zamiast odwołania do nieistniejącego `life-queries.js`.
5. Traktować ten plik jako pierwszy punkt wejścia, a pełne szczegóły brać z mapy architektury i knowledge synth.
