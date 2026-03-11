# CONFIG STRATEGY v0 — .env / config

Data: 2026-03-08
Status: Draft v0.1

## Cel

Ustawić prostą, bezpieczną i przewidywalną konfigurację dla wersji podstawowej, bez ukrytej magii i bez trzymania sekretów w repo.

---

## 1) Źródła konfiguracji (priorytet)

1. Zmienne środowiskowe (ENV) — najwyższy priorytet
2. `.env.local` (lokalnie, niecommitowany)
3. `.env` (lokalny baseline deweloperski, bez sekretów)
4. Twarde defaulty w kodzie (tylko bezpieczne)

Zasada: brak wartości krytycznych = fail-fast przy starcie.

---

## 2) Pliki konfiguracyjne

- `.env.example` — pełna lista kluczy + przykładowe wartości
- `.env` — lokalny config developerski (bez realnych sekretów)
- `.env.local` — realne lokalne sekrety (gitignored)

`/.gitignore` musi zawierać:

- `.env.local`
- `.env.*.local`
- `*.secret`

---

## 3) Klucze v0 (proponowane)

### Core

- `NODE_ENV=development|test|production`
- `PORT=3000`
- `LOG_LEVEL=debug|info|warn|error`

### Providers

- `DEFAULT_PROVIDER=shared-llm|decentralized-llm|local-fallback`
- `SHARED_LLM_API_BASE=`
- `SHARED_LLM_API_KEY=`
- `DECENTRALIZED_LLM_API_BASE=`
- `DECENTRALIZED_LLM_API_KEY=`
- `LOCAL_FALLBACK_ENABLED=true|false`

### Generation defaults

- `GEN_TIMEOUT_MS=30000`
- `GEN_MAX_TOKENS=512`
- `GEN_TEMPERATURE=0.4`

### Storage

- `DATABASE_URL=file:./data/memphis-v4.db`

---

## 4) Walidacja konfiguracji

- Konfiguracja walidowana przy starcie przez schema (Zod).
- Błąd walidacji kończy proces z czytelną listą braków/błędów.
- Żadnego „silent fallback” dla kluczy API.

---

## 5) Zasady bezpieczeństwa

- Sekrety wyłącznie w ENV / secret managerze.
- Nigdy nie logujemy pełnych wartości tokenów/kluczy.
- W logach maskowanie (`***`) dla pól wrażliwych.
- `.env.example` bez realnych wartości.

---

## 6) Runtime profiles (v0)

### development

- bardziej verbose logi
- lokalne endpointy providerów dopuszczalne

### production

- `LOG_LEVEL=info` (lub wyżej)
- wymagane kompletne klucze dla aktywnego providera
- surowsze timeouty/retry

---

## 7) Migration-friendly config

- Nazwy kluczy stabilne i opisowe.
- Deprecated keys oznaczane i wspierane przez 1 wersję przejściową.
