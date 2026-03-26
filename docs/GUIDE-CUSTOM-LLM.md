# Instruktaż: Podłączanie Własnego LLM

# Guide: Connecting a Custom LLM Provider

---

## Spis treści

1. [Szybki start — OpenAI-compatible](#1-szybki-start)
2. [Providery wbudowane](#2-providery-wbudowane)
3. [Autentykacja: API Key vs OAuth](#3-autentykacja)
4. [Krok po kroku: nowy provider z API Key](#4-nowy-provider-api-key)
5. [Krok po kroku: provider z OAuth](#5-provider-oauth)
6. [Vault — bezpieczne przechowywanie sekretów](#6-vault)
7. [Testowanie i diagnostyka](#7-testowanie)
8. [Zaawansowane: własny adapter od zera](#8-wlasny-adapter)

---

## 1. Szybki start

Jeśli Twój provider jest **OpenAI-compatible** (np. Together, Groq, Mistral, vLLM, LM Studio), wystarczy `.env`:

```dotenv
DEFAULT_PROVIDER=shared-llm
SHARED_LLM_API_BASE=https://api.together.xyz/v1
SHARED_LLM_API_KEY=sk-your-key-here
```

Zweryfikuj:

```bash
npm run -s cli -- doctor --json
npm run -s cli -- providers:health
```

Gotowe. Memphis wyśle requesty do `/v1/generate` z `Authorization: Bearer <key>`.

---

## 2. Providery wbudowane

Memphis ma 7 aktywnych providerów `v1.0.0`. Każdy aktywuje się automatycznie po ustawieniu odpowiednich zmiennych:

| Provider | Env vars | Protokół |
|---|---|---|
| **Ollama** (domyślny) | `OLLAMA_URL`, `OLLAMA_MODEL` | `/api/chat` (natywny Ollama) |
| **Shared LLM** | `SHARED_LLM_API_BASE`, `SHARED_LLM_API_KEY` | `/v1/generate` + Bearer |
| **Decentralized LLM** | `DECENTRALIZED_LLM_API_BASE`, `DECENTRALIZED_LLM_API_KEY` | `/v1/generate` + Bearer |
| **MiniMax** | `MINIMAX_API_KEY`, `MINIMAX_MODEL` | OpenAI-compatible + legacy fallback |
| **DeepSeek** | `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` | OpenAI-compatible |
| **GLM** | `GLM_API_KEY`, `GLM_MODEL` | OpenAI-compatible |
| **Local Fallback** | `LOCAL_FALLBACK_ENABLED=true` | Lokalny echo (offline) |

**Wybór domyślnego**: `DEFAULT_PROVIDER=ollama|shared-llm|decentralized-llm|minimax|deepseek|glm|local-fallback`

**Failover**: Jeśli domyślny provider padnie, Memphis automatycznie przełącza na `local-fallback`.

---

## 3. Autentykacja

### 3a. Bearer Token (API Key)

Najprostszy i najczęstszy. Klucz trafia do nagłówka HTTP:

```
Authorization: Bearer sk-your-key-here
```

Obsługiwane kody błędów:
- `401/403` → nieprawidłowy klucz
- `429` → rate limit
- `5xx` → provider niedostępny

### 3b. OAuth 2.0 (Client Credentials / Authorization Code)

Memphis nie ma wbudowanego flow OAuth, ale obsługuje go przez **token refresh w kliencie**.

Schemat:

```
┌──────────────┐     ┌───────────────┐     ┌──────────────┐
│ Memphis      │────▶│ OAuth Server  │────▶│ Access Token │
│ (client.ts)  │◀────│ /oauth/token  │     │ (cached)     │
└──────┬───────┘     └───────────────┘     └──────┬───────┘
       │                                          │
       │  Authorization: Bearer <access_token>    │
       └──────────────────────────────────────────▶│
                                           ┌──────▼───────┐
                                           │ LLM Endpoint │
                                           └──────────────┘
```

Potrzebne dane (wstaw do `.env` lub vaulta):

```dotenv
CUSTOM_LLM_OAUTH_CLIENT_ID=your-client-id
CUSTOM_LLM_OAUTH_CLIENT_SECRET=VAULT:oauth_client_secret
CUSTOM_LLM_OAUTH_TOKEN_URL=https://auth.provider.com/oauth/token
CUSTOM_LLM_API_BASE=https://api.provider.com/v1
```

---

## 4. Nowy provider z API Key — krok po kroku

### Krok 1: Dodaj zmienne do schematu

Plik: `src/infra/config/schema.ts`

```typescript
// Dodaj w obiekcie envSchema:
CUSTOM_LLM_API_BASE: z.string().url().optional(),
CUSTOM_LLM_API_KEY: z.string().optional(),
CUSTOM_LLM_MODEL: z.string().default('your-default-model'),
```

### Krok 2: Dodaj klucz do vault-resolve

Plik: `src/infra/config/vault-resolve.ts`

Dodaj `'CUSTOM_LLM_API_KEY'` do tablicy `VAULT_RESOLVABLE_KEYS`.

### Krok 3: Stwórz klienta HTTP

Plik: `src/providers/custom-llm/client.ts`

```typescript
import { AppError, errorTemplates } from '../../core/errors.js';

export class CustomLlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  async healthCheck() {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(2000),
      });
      return { ok: res.ok, latencyMs: Date.now() - started };
    } catch {
      return { ok: false, error: 'unreachable' };
    }
  }

  async generate(payload: {
    input: string;
    model?: string;
    options?: { temperature?: number; maxTokens?: number; timeoutMs?: number };
  }) {
    const timeoutMs = payload.options?.timeoutMs ?? this.defaultTimeoutMs;
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: payload.model,
        messages: [{ role: 'user', content: payload.input }],
        temperature: payload.options?.temperature,
        max_tokens: payload.options?.maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 401 || res.status === 403)
      throw errorTemplates.invalidApiKey({ provider: 'custom-llm', status: res.status });
    if (res.status === 429)
      throw new AppError('PROVIDER_RATE_LIMIT', 'Rate limited', 429);
    if (res.status >= 500)
      throw new AppError('PROVIDER_UNAVAILABLE', `HTTP ${res.status}`, 503);

    const data = await res.json();
    return {
      output: data.choices?.[0]?.message?.content ?? '',
      model: data.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens,
      },
    };
  }
}
```

### Krok 4: Stwórz adapter (LLMProvider)

Plik: `src/providers/custom-llm/adapter.ts`

```typescript
import { randomUUID } from 'node:crypto';
import type { LLMProvider } from '../../core/contracts/llm-provider.js';
import type { GenerateInput, GenerateResult, ProviderHealth } from '../../core/types.js';
import type { CustomLlmClient } from './client.js';

export class CustomLlmProvider implements LLMProvider {
  readonly name = 'custom-llm' as const;

  constructor(private readonly client: CustomLlmClient) {}

  async healthCheck(): Promise<ProviderHealth> {
    const result = await this.client.healthCheck();
    return { name: this.name, ok: result.ok, latencyMs: result.latencyMs };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const started = Date.now();
    const data = await this.client.generate({
      input: input.input,
      model: input.model,
      options: input.options,
    });
    return {
      id: `gen_${randomUUID()}`,
      providerUsed: this.name,
      modelUsed: data.model,
      output: data.output,
      usage: data.usage,
      timingMs: Date.now() - started,
    };
  }
}
```

### Krok 5: Zarejestruj w kontenerze DI

Plik: `src/app/container.ts`

```typescript
if (config.CUSTOM_LLM_API_BASE && config.CUSTOM_LLM_API_KEY) {
  const client = new CustomLlmClient(
    config.CUSTOM_LLM_API_BASE,
    config.CUSTOM_LLM_API_KEY,
    config.GEN_TIMEOUT_MS,
  );
  providers.push(new CustomLlmProvider(client));
}
```

### Krok 6: Dodaj typ

Plik: `src/core/types.ts` — dodaj `'custom-llm'` do unii `ProviderName`.

### Krok 7: Konfiguruj i testuj

```dotenv
# .env
DEFAULT_PROVIDER=custom-llm
CUSTOM_LLM_API_BASE=https://api.your-provider.com
CUSTOM_LLM_API_KEY=sk-your-key
CUSTOM_LLM_MODEL=your-model
```

```bash
npm run -s cli -- providers:health
npm run -s cli -- doctor --json
```

---

## 5. Provider z OAuth — krok po kroku

Rozszerz klienta z kroku 3 o automatyczny token refresh:

```typescript
export class OAuthLlmClient {
  private accessToken = '';
  private tokenExpiresAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly tokenUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly defaultTimeoutMs = 30_000,
  ) {}

  /** Pobiera lub odświeża token OAuth */
  private async ensureValidToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.accessToken;
    }

    const res = await fetch(this.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new AppError('AUTH_FAILED', `OAuth token request failed: ${res.status}`, 401);
    }

    const data = await res.json();
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }

  async generate(payload: { input: string; model?: string; options?: Record<string, unknown> }) {
    const token = await this.ensureValidToken();

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: payload.model,
        messages: [{ role: 'user', content: payload.input }],
      }),
      signal: AbortSignal.timeout(this.defaultTimeoutMs),
    });

    // ... obsługa błędów jak w kliencie API Key
    const data = await res.json();
    return {
      output: data.choices?.[0]?.message?.content ?? '',
      model: data.model,
    };
  }
}
```

**Env vars:**

```dotenv
CUSTOM_LLM_OAUTH_CLIENT_ID=your-client-id
CUSTOM_LLM_OAUTH_CLIENT_SECRET=VAULT:oauth_secret
CUSTOM_LLM_OAUTH_TOKEN_URL=https://auth.provider.com/oauth/token
CUSTOM_LLM_API_BASE=https://api.provider.com
```

Schema i vault-resolve — dodaj analogicznie do sekcji 4.

---

## 6. Vault — bezpieczne sekrety

Zamiast trzymać klucze w `.env` plain-text, użyj vaulta:

```bash
# Zapisz sekret
npm run -s cli -- vault set custom_api_key "sk-your-actual-key"

# Użyj w .env
CUSTOM_LLM_API_KEY=VAULT:custom_api_key
```

Memphis automatycznie rozwiąże `VAULT:custom_api_key` → odszyfrowana wartość przy starcie.

Klucz vaulta wymaga dodania do `VAULT_RESOLVABLE_KEYS` w `vault-resolve.ts`.

---

## 7. Testowanie i diagnostyka

```bash
# Sprawdź konfigurację
npm run -s cli -- doctor --json

# Sprawdź dostępność providera
npm run -s cli -- providers:health

# Lista providerów i modeli
npm run -s cli -- providers list
npm run -s cli -- models list

# Test generacji (przez MCP lub HTTP)
curl -X POST http://localhost:3000/v1/generate \
  -H "Authorization: Bearer $MEMPHIS_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello, test"}'
```

**Troubleshooting:**

| Problem | Rozwiązanie |
|---|---|
| `INVALID_API_KEY` | Sprawdź klucz, vault resolution, format |
| `PROVIDER_TIMEOUT` | Zwiększ `GEN_TIMEOUT_MS` (domyślnie 30s) |
| `PROVIDER_UNAVAILABLE` | Sprawdź URL, sieć, status serwisu |
| `PROVIDER_RATE_LIMIT` | Poczekaj lub zmień plan u providera |
| Provider nie pojawia się | Sprawdź czy zmienne w `.env` są ustawione (base + key) |

---

## 8. Zaawansowane: parametry generacji

Globalne parametry wpływające na wszystkich providerów:

```dotenv
GEN_TIMEOUT_MS=30000        # Timeout na request (100-120000 ms)
GEN_MAX_TOKENS=512          # Max tokenów w odpowiedzi (1-32768)
GEN_TEMPERATURE=0.4         # Losowość (0.0-2.0, 0=deterministyczne)
```

**Profile produkcyjne** automatycznie ograniczają:
- `GEN_TIMEOUT_MS` → max 20 000 ms
- `GEN_MAX_TOKENS` → max 1024

**Orchestration features:**
- Automatyczny failover do `local-fallback`
- Cooldown 15-30s po awarii providera
- 2 retries z exponential backoff
- Latency-aware routing (strategia `latency-aware`)
