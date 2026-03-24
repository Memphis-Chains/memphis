# Instruktaż: Konfiguracja Pierwszego Startu

# Guide: First Bootstrap Configuration

---

## Spis treści

1. [Przegląd — co się dzieje przy starcie](#1-przeglad)
2. [Przed pierwszym startem: setup wizard](#2-setup-wizard)
3. [Ręczna konfiguracja .env](#3-reczna-konfiguracja)
4. [Sekwencja bootstrap — co robi każdy krok](#4-sekwencja-bootstrap)
5. [Struktura katalogów po starcie](#5-struktura-katalogow)
6. [Soul seeding — tożsamość agenta](#6-soul-seeding)
7. [Customizacja przed startem](#7-customizacja-przed-startem)
8. [Customizacja po starcie](#8-customizacja-po-starcie)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. Przegląd

Pierwszy start Memphis to **22-krokowa sekwencja** w `src/app/bootstrap.ts`, która:

1. Waliduje konfigurację
2. Sprawdza bezpieczeństwo i integralność
3. Inicjalizuje bazę danych, łańcuchy, vault
4. Seeduje "duszę" agenta (tożsamość, wiedza, granice)
5. Uruchamia serwer HTTP, watchdog, gateway, refleksje

```
memphis setup          memphis serve / npm run dev
     │                        │
     ▼                        ▼
 .env created        ┌─ Config load + validate
                     ├─ Security guards
                     ├─ Chain integrity
                     ├─ Rust bridge warmup
                     ├─ Soul manifest + seeding ← PIERWSZA TOŻSAMOŚĆ
                     ├─ SQLite migrations
                     ├─ Queue/webhook recovery
                     ├─ Snapshot pruning
                     ├─ HTTP server start
                     ├─ Heartbeat watchdog
                     ├─ Channel gateway (opcjonalnie)
                     └─ Reflection scheduler
```

---

## 2. Setup Wizard

Interaktywny wizard generuje `.env` i profil agenta:

```bash
npm run -s cli -- setup
```

### Co pyta wizard:

| Krok | Pytanie | Domyślna wartość |
|---|---|---|
| 1 | Nazwa agenta | `Memphis Agent` |
| 2 | Nazwa operatora | `local operator` |
| 3 | Provider LLM | `ollama` |
| 4 | URL providera | Zależnie od wyboru |
| 5 | API Key | Opcjonalnie |
| 6 | Katalog danych | `./data` |
| 7 | Backend embeddingów | `local` (32-dim) |
| 8 | Vault pepper | Auto-generowany |

### Co tworzy wizard:

- **`.env`** — pełna konfiguracja środowiska
- **`~/.memphis/config/agent-profile.json`** — tożsamość agenta:
  ```json
  {
    "agentName": "Memphis Agent",
    "ownerName": "local operator",
    "runtimeMode": "solo-local",
    "toolPolicy": "operator-supervised",
    "behaviorRules": [...]
  }
  ```
- **`MEMPHIS_API_TOKEN`** — auto-generowany (24 random bytes, base64url)
- **`MEMPHIS_VAULT_PEPPER`** — auto-generowany (16 random hex bytes)

### Alternatywa: `npm run bootstrap`

Automatyczny tryb bez pytań — tworzy `.env` z bezpiecznymi domyślnymi i instaluje systemd service.

---

## 3. Ręczna konfiguracja .env

Zamiast wizarda, możesz stworzyć `.env` ręcznie. Minimalna konfiguracja:

```dotenv
# === MINIMUM VIABLE ===
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATABASE_URL=file:./data/memphis.db

# Provider (wybierz jeden)
DEFAULT_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=cogito:3b

# Bezpieczeństwo
MEMPHIS_API_TOKEN=your-random-token-here
MEMPHIS_VAULT_PEPPER=your-pepper-min-12-chars

# Rust bridge
RUST_CHAIN_ENABLED=true
```

**Pełna konfiguracja** — patrz `docs/CONFIGURATION.md` lub `.env.example`.

### Generowanie tokenów ręcznie

```bash
# API token (24 random bytes)
python3 -c "import secrets; print(secrets.token_urlsafe(24))"

# Vault pepper (16 random hex bytes)
python3 -c "import secrets; print(f'memphis-{secrets.token_hex(16)}')"
```

---

## 4. Sekwencja bootstrap — szczegółowo

### Faza 1: Pre-check

| Krok | Co robi | Fail = ? |
|---|---|---|
| .env check | Czy plik `.env` istnieje | **FATAL** — "Run: `memphis init`" |
| Config load | Walidacja Zod + vault resolve | **FATAL** — nieprawidłowe zmienne |
| Profile apply | dev/test/prod normalizacja | Automatyczne |

### Faza 2: Security

| Krok | Co robi | Fail = ? |
|---|---|---|
| Trust root | Weryfikacja zaufanej bazy | Warning |
| Revocation cache | Sprawdzenie aktualności | Warning |
| Safe mode | Ustawienie restrykcji write | Automatyczne |

### Faza 3: Infrastructure

| Krok | Co robi | Fail = ? |
|---|---|---|
| Ollama check | Połączenie z Ollama (jeśli embed=ollama) | **FATAL** jeśli wymagane |
| Chain verify | SHA-256 integralność łańcuchów | Warning (kontynuuje) |
| Rust bridge | NAPI vault + embed warmup | Warning (TS fallback) |
| Embed pipeline | Eager init HNSW indeksu | Warning |

### Faza 4: Soul (TYLKO PIERWSZY START)

| Krok | Co robi | Fail = ? |
|---|---|---|
| Soul manifest | Generuje `soul-manifest.json` | Warning |
| Soul seeding | 5 wpisów journal + 8 wpisów case | Warning |
| Soul memory | Inicjalizuje `soul-memory.json` | Warning |

### Faza 5: Recovery & maintenance

| Krok | Co robi | Fail = ? |
|---|---|---|
| Evolve recovery | Rollback crashniętych sesji | Warning |
| Case index reconcile | Odbudowa HNSW z case chain | Warning |
| DI container | SQLite + migracje + providery | **FATAL** |
| Queue recovery | Wznowienie zadań | Warning |
| Job recovery | Wznowienie scheduled jobs | Warning |
| Webhook recovery | Wznowienie eventów | Warning |
| Peer cleanup | Oznaczenie stale peers offline | Warning |
| Snapshot prune | Usunięcie starych snapshotów | Warning |
| Chain rotation | Archiwizacja dużych łańcuchów | Warning |

### Faza 6: Runtime

| Krok | Co robi | Fail = ? |
|---|---|---|
| HTTP server | Fastify start na HOST:PORT | **FATAL** |
| Heartbeat | Watchdog co 60s | Warning |
| Channel gateway | Telegram/Discord (jeśli enabled) | Warning |
| Reflection | Scheduler (co 24h, delay 5min) | Warning |

---

## 5. Struktura katalogów po starcie

```
./data/                              (lub MEMPHIS_DATA_DIR)
├── memphis.db                       ← SQLite (sesje, eventy, approvals)
├── memphis.db-wal                   ← Write-ahead log
├── embed-index.json                 ← HNSW embedding index
├── vault-entries.json               ← Zaszyfrowane sekrety
├── vault-state.json                 ← Metadata vaulta
├── queue.wal                        ← Task queue WAL
├── security-audit.jsonl             ← Append-only audit log
├── last-boot.json                   ← Crash detection
├── chains/
│   ├── journal/                     ← Pamięć agenta (JSONL bloki)
│   ├── decisions/                   ← Zarejestrowane decyzje
│   ├── system/                      ← Audit LLM calls, tool calls
│   ├── reflections/                 ← Dzienne refleksje
│   └── cases/                       ← Graf wiedzy (polskie przypadki)
├── backups/                         ← Snapshoty
├── snapshots/                       ← Evolution snapshots
├── embeddings/                      ← Cache embeddingów
├── apps/                            ← Managed apps
└── logs/                            ← Logi

~/.memphis/config/
├── agent-profile.json               ← Tożsamość agenta
├── soul-manifest.json               ← Capabilities, granice, DID
└── soul-memory.json                 ← Pamięć duszy (user prefs, self-knowledge)
```

---

## 6. Soul seeding — co się dzieje

Przy **pierwszym starcie** Memphis zapisuje tożsamość agenta:

### Soul memory (`soul-memory.json`)

```json
{
  "user": {
    "name": "operator-name",
    "languages": ["pl", "en"],
    "preferences": [...],
    "expertise": [...]
  },
  "self": {
    "personality": [...],
    "learnings": [],
    "evolvedCapabilities": []
  },
  "context": {
    "activeWork": [],
    "recentDecisions": []
  }
}
```

### Journal chain — 5 wpisów fundacyjnych

1. **`soul-seed:identity`** — "Jestem [agent] — suwerenny agent AI [owner]a..."
2. **`soul-seed:architecture`** — Rust NAPI + TypeScript runtime
3. **`soul-seed:capabilities`** — Lista narzędzi (journal, recall, decide, vault...)
4. **`soul-seed:providers`** — Skonfigurowane providery LLM
5. **`soul-seed:boundaries`** — Tier 0/1/2, reguły self-modyfikacji

### Case chain — 8 wpisów (polskie przypadki gramatyczne)

| Przypadek | Rola semantyczna | Przykład |
|---|---|---|
| Mianownik | Co istnieje | Tożsamość agenta |
| Dopełniacz | Co posiada | Capabilities, pamięć |
| Celownik | Komu służy | Audytowalną pomoc AI |
| Biernik | Co orkiestruje | Narzędzia, pamięć, decyzje |
| Narzędnik | Jak działa | Rust bridge + TS runtime |
| Miejscownik | Gdzie żyje | Maszyna operatora |
| Ablativus | Skąd → dokąd | Pusty stan → samoświadomy agent |
| Wołacz | Jak wołać | CLI, TUI, HTTP, MCP, Telegram |

**Seeding jest idempotentny** — uruchamia się tylko raz, przy pustej soul memory.

---

## 7. Customizacja PRZED pierwszym startem

### Tożsamość agenta

```dotenv
MEMPHIS_AGENT_NAME=Mój Agent
MEMPHIS_OWNER_NAME=Marcin
MEMPHIS_DID=did:memphis:custom-identifier
```

### Provider LLM

```dotenv
# Ollama (lokalne)
DEFAULT_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b

# Lub cloud
DEFAULT_PROVIDER=shared-llm
SHARED_LLM_API_BASE=https://api.together.xyz/v1
SHARED_LLM_API_KEY=sk-xxx
```

### Embeddingi

```dotenv
# Lokalne (szybkie, 32-dim, offline)
RUST_EMBED_MODE=local
RUST_EMBED_DIM=32

# Ollama (lepsze, 768-dim, wymaga ollama pull nomic-embed-text)
RUST_EMBED_MODE=ollama
RUST_EMBED_DIM=768
RUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434
RUST_EMBED_PROVIDER_MODEL=nomic-embed-text
```

### Bezpieczeństwo

```dotenv
# Strict mode — fail-closed na policy violations
MEMPHIS_STRICT_MODE=true

# Safe mode — brak write operations
MEMPHIS_SAFE_MODE=true

# Autonomy mode w agent-profile.json:
# "quiet" — minimalne proaktywne działania
# "balanced" — mix guided + autonomous
# "paranoid" — wszystko wymaga approval
```

### Gateway (exec hardening)

```dotenv
GATEWAY_EXEC_RESTRICTED_MODE=true
GATEWAY_EXEC_ALLOWLIST=echo,pwd,ls,whoami,date,uptime
```

### Telegram (opcjonalne)

```dotenv
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=VAULT:telegram_token
```

---

## 8. Customizacja PO starcie

### Zmiana konfiguracji runtime

Edytuj `.env` i zrestartuj:

```bash
# Edytuj
nano .env

# Zrestartuj
npm run dev
# lub
npm run -s cli -- service restart
```

### Rekonfiguracja interaktywna

```bash
npm run -s cli -- configure
```

### Weryfikacja stanu

```bash
npm run -s cli -- doctor --json     # Diagnostyka konfiguracji
npm run -s cli -- health --json     # Stan runtime
npm run -s cli -- guide             # Operator story
npm run -s cli -- providers:health  # Stan providerów
```

### Modyfikacja soul memory (po starcie)

Przez MCP tool `memphis_soul_write`:

```json
{
  "section": "user",
  "data": {
    "name": "Marcin",
    "languages": ["pl", "en"],
    "expertise": ["Rust", "TypeScript", "security"]
  }
}
```

Lub bezpośrednio edytuj `~/.memphis/config/soul-memory.json` i zrestartuj.

### Migracje bazy danych

Automatyczne — Memphis sprawdza wersję schema przy starcie i uruchamia brakujące migracje (aktualnie schema v8).

---

## 9. Troubleshooting

| Problem | Przyczyna | Rozwiązanie |
|---|---|---|
| "Memphis has not been initialized yet" | Brak `.env` | `npm run -s cli -- setup` |
| "Invalid environment configuration" | Błędne zmienne | `npm run -s cli -- doctor --json` |
| Ollama unreachable | Ollama nie działa | `ollama serve` w osobnym terminalu |
| Rust bridge unavailable | NAPI nie zbudowany | `npm run build:rust` + `cp .so` (patrz NAPI docs) |
| Soul seeding failed | Brak katalogu config | `mkdir -p ~/.memphis/config` |
| Database locked | Inny proces | Zamknij inne instancje Memphis |
| Port in use | Inny serwis na porcie | Zmień `PORT` w `.env` |
| Chain integrity error | Uszkodzony łańcuch | Sprawdź `data/chains/`, rozważ snapshot restore |

### Reset do stanu początkowego

```bash
# UWAGA: to kasuje WSZYSTKIE dane agenta!
rm -rf ./data
rm -rf ~/.memphis/config/soul-memory.json
rm -rf ~/.memphis/config/soul-manifest.json
npm run dev   # Soul seeding uruchomi się ponownie
```

### Logi diagnostyczne

```dotenv
LOG_LEVEL=debug
LOG_FORMAT=json    # Maszynowy parsing
```

```bash
# Security audit log (append-only)
cat data/security-audit.jsonl | jq .
```
