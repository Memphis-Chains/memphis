# LOGGING & ERROR POLICY v0

Data: 2026-03-08
Status: Draft v0.1

## Cel

Zapewnić czytelne logi operacyjne i spójne błędy w całym systemie, tak aby debugging i utrzymanie produkcyjne były szybkie i przewidywalne.

---

## 1) Log levels (v0)

- `debug` — szczegóły developerskie (tylko dev)
- `info` — normalny przebieg operacji
- `warn` — odchylenia, retry, fallback użyty
- `error` — błędy operacyjne, nieudana akcja

Domyślnie:

- development: `debug`
- production: `info`

---

## 2) Format logów

- JSON lines (1 event = 1 linia)
- Każdy log zawiera minimum:
  - `ts` (ISO timestamp)
  - `level`
  - `service` (`memphis-v4`)
  - `module` (np. `providers/shared-llm`)
  - `event` (np. `provider.generate.success`)
  - `message`
  - `requestId` (jeśli dotyczy)

Przykład:

```json
{
  "ts": "2026-03-08T16:30:00.120Z",
  "level": "info",
  "service": "memphis-v4",
  "module": "providers/shared-llm",
  "event": "provider.generate.success",
  "message": "Generation completed",
  "requestId": "req_abc123",
  "timingMs": 842
}
```

---

## 3) Zasady logowania

- Logujemy zdarzenia istotne operacyjnie (start/stop requestu, fallback, retry, fail).
- Nie logujemy payloadów z wrażliwymi danymi.
- Klucze/tokenu/API secrets zawsze maskowane.
- Nie spamujemy logów powtarzalnym szumem.

---

## 4) Error taxonomy (wspólny model)

### Kody domenowe (v0)

- `VALIDATION_ERROR`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_TIMEOUT`
- `PROVIDER_RATE_LIMIT`
- `CONFIG_ERROR`
- `INTERNAL_ERROR`

### HTTP mapowanie

- `VALIDATION_ERROR` → 400
- `PROVIDER_TIMEOUT` → 504
- `PROVIDER_RATE_LIMIT` → 429
- `PROVIDER_UNAVAILABLE` → 503
- `CONFIG_ERROR` → 500 (startup fail-fast)
- `INTERNAL_ERROR` → 500

---

## 5) Error response contract

Każdy błąd API:

```json
{
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "Provider did not respond in time",
    "details": {
      "provider": "shared-llm"
    },
    "requestId": "req_abc123"
  }
}
```

`message` = bezpieczny dla użytkownika (bez wycieku implementacji/secrets).

---

## 6) Retry / fallback policy (v0)

- Retry tylko dla błędów przejściowych (timeout/5xx/rate-limit zgodnie z backoff).
- Max retry: 2 (z exponential backoff + jitter).
- Po przekroczeniu retry: fallback provider (jeśli skonfigurowany).
- Każdy retry i fallback musi być zalogowany (`warn`).

---

## 7) Correlation IDs

- API generuje `requestId` per request (lub przyjmuje z nagłówka, jeśli trusted).
- `requestId` propagowany przez cały flow (API -> module -> provider -> response).
- Ułatwia triage i observability.
