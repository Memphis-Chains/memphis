# INTERFACES CONTRACT v0 — API / CLI

Data: 2026-03-08
Status: Draft v0.1

## Cel

Zdefiniować minimalny, stabilny kontrakt interfejsów dla wersji podstawowej (working product), z możliwością rozbudowy bez łamania kompatybilności.

---

## 1) HTTP API (v0)

### 1.1 Health

- `GET /health`
- Response 200:

```json
{
  "status": "ok",
  "service": "memphis-v4",
  "version": "0.1.0"
}
```

### 1.2 Providers health

- `GET /v1/providers/health`
- Response 200:

```json
{
  "defaultProvider": "shared-llm",
  "providers": [
    { "name": "shared-llm", "ok": true, "latencyMs": 120 },
    { "name": "decentralized-llm", "ok": false, "error": "TIMEOUT" }
  ]
}
```

### 1.3 Chat generate

- `POST /v1/chat/generate`
- Request:

```json
{
  "input": "Napisz krótki plan dnia",
  "provider": "auto",
  "model": "optional-model-id",
  "sessionId": "optional-session-id",
  "options": {
    "temperature": 0.4,
    "maxTokens": 512,
    "timeoutMs": 30000
  }
}
```

- Response 200:

```json
{
  "id": "gen_123",
  "providerUsed": "shared-llm",
  "modelUsed": "model-x",
  "output": "Oto plan dnia...",
  "usage": { "inputTokens": 23, "outputTokens": 91 },
  "timingMs": 840
}
```

### 1.4 Error format (wspólny)

Każdy endpoint zwraca błędy w formacie:

```json
{
  "error": {
    "code": "PROVIDER_TIMEOUT",
    "message": "Provider did not respond in time",
    "details": {}
  }
}
```

---

## 2) CLI (v0)

### 2.1 Komendy

- `memphis-v4 health`
- `memphis-v4 providers:health`
- `memphis-v4 chat --input "..." [--provider auto|shared|decentralized|local] [--model ...]`

### 2.2 Kontrakt wyjścia

- domyślnie: human-readable tekst
- `--json`: dokładnie ten sam schemat danych co API

### 2.3 Kody wyjścia

- `0` sukces
- `2` błąd walidacji wejścia
- `3` błąd providera
- `4` błąd systemowy

---

## 3) Provider abstraction contract (TS)

```ts
export type GenerateInput = {
  input: string;
  sessionId?: string;
  model?: string;
  options?: {
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
};

export type GenerateResult = {
  providerUsed: string;
  modelUsed?: string;
  output: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  timingMs: number;
};

export interface LLMProvider {
  name: string;
  healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}
```

---

## 4) Zasady kompatybilności

- API versioning przez prefiks `/v1`.
- W v0 nie usuwamy pól z odpowiedzi — tylko dodajemy opcjonalne.
- Zmiany breaking: dopiero przez `/v2`.
