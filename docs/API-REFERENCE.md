# Memphis v5 API Reference

Version scope: `@memphis-chains/memphis` `0.2.0-beta.1` (current repo state)

Base URL (HTTP server):
- Default: `http://127.0.0.1:3000`

Base URL (Gateway server):
- Configurable host/port via gateway bootstrap

## Authentication

Memphis HTTP API uses bearer token auth when `MEMPHIS_API_TOKEN` is configured.

```http
Authorization: Bearer <MEMPHIS_API_TOKEN>
```

Auth behavior:
- Some endpoints are explicitly public (`/health`, `/v1/providers/health`).
- Other endpoints require auth by policy.
- If `MEMPHIS_API_TOKEN` is unset, auth checks are effectively bypassed (recommended only for local/dev).

Gateway auth behavior:
- `/exec` has separate strict auth policy (and optional local loopback bypass in dangerous dev mode).
- Other gateway routes with `auth=true` use gateway token.

---

## Error Envelope

Most API errors return:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "suggestion": "Optional remediation hint",
    "details": {},
    "requestId": "uuid-or-generated-id"
  }
}
```

Common error codes:
- `VALIDATION_ERROR` (400)
- `UNAUTHORIZED` (401)
- `NOT_FOUND` (404)
- `PROVIDER_RATE_LIMIT` (429)
- `PROVIDER_UNAVAILABLE` (503)
- `INTERNAL_ERROR` (500)
- `MISSING_ENV`, `MISSING_OLLAMA`, `INVALID_API_KEY`, `NETWORK_ERROR`, `PERMISSION_DENIED`

---

## Rate Limiting

### Main HTTP server
- Global limiter: **120 req/min** per `IP:METHOD`
- Sensitive limiter: **20 req/min** per `IP:METHOD:PATH`

Sensitive routes include:
- `/metrics`
- `/v1/chat/generate`
- `/v1/metrics`
- `/v1/ops/status`
- `/v1/sessions`
- `/v1/sessions/:sessionId/events`
- `/v1/vault/init`
- `/v1/vault/encrypt`
- `/v1/vault/decrypt`
- `/v1/vault/entries`

### Gateway server
- Sensitive limiter for `/exec` and `/provider/chat`: **20 req/min**
- Extra limiter for `/exec`: **10 req/min**

429 details include `retryAfterMs`.

---

## Main HTTP API Endpoints

## 1) Health & Ops

### GET `/health`
Health probe.

Auth: public

Response (200 healthy or 503 degraded):
```json
{
  "status": "healthy",
  "service": "memphis-v5",
  "timestamp": "2026-03-11T11:00:00.000Z"
}
```

### GET `/v1/providers/health`
Provider health snapshot.

Auth: public

Response:
```json
{
  "defaultProvider": "ollama",
  "providers": [
    { "name": "ollama", "ok": true, "latencyMs": 34 },
    { "name": "shared-llm", "ok": false, "error": "not configured" }
  ]
}
```

### GET `/metrics`
Prometheus text metrics.

Auth: required by default policy

Response:
- `200 text/plain` if enabled
- `404` with `metrics endpoint disabled` if disabled

### GET `/v1/metrics`
JSON metrics snapshot.

Auth: required

### GET `/v1/ops/status`
Operational status summary.

Auth: required

Response:
```json
{
  "service": "memphis-v5",
  "version": "0.1.0",
  "uptimeSec": 1234,
  "defaultProvider": "ollama",
  "providers": [],
  "metrics": {},
  "health": { "level": "healthy" },
  "adapters": {
    "chain": {},
    "vault": {}
  },
  "timestamp": "2026-03-11T11:00:00.000Z"
}
```

---

## 2) Chat Generation

### POST `/v1/chat/generate`
Generate a model response through orchestration and provider routing.

Auth: required

Request schema:
```json
{
  "input": "string (1..20000)",
  "provider": "auto|shared-llm|decentralized-llm|local-fallback|ollama",
  "model": "string (optional)",
  "sessionId": "string (optional)",
  "strategy": "default|latency-aware",
  "options": {
    "temperature": 0.0,
    "maxTokens": 2048,
    "timeoutMs": 30000
  }
}
```

Response schema:
```json
{
  "id": "gen_...",
  "providerUsed": "ollama",
  "modelUsed": "qwen2.5:7b",
  "output": "Generated text",
  "usage": {
    "inputTokens": 100,
    "outputTokens": 230
  },
  "timingMs": 531,
  "trace": {
    "strategy": "default",
    "requestedProvider": "auto",
    "attempts": [
      {
        "attempt": 1,
        "provider": "ollama",
        "viaFallback": false,
        "ok": true,
        "latencyMs": 531
      }
    ]
  }
}
```

---

## 3) Vault API

### POST `/v1/vault/init`
Initialize vault context (passphrase + recovery Q&A) and derive DID.

Auth: required

Request:
```json
{
  "passphrase": "min 8 chars",
  "recovery_question": "string",
  "recovery_answer": "string"
}
```

Response:
```json
{
  "ok": true,
  "vault": {
    "version": 1,
    "did": "did:memphis:..."
  }
}
```

### POST `/v1/vault/encrypt`
Encrypt and persist one vault entry.

Auth: required

Request:
```json
{
  "key": "api_key",
  "plaintext": "secret-value"
}
```

Response:
```json
{
  "ok": true,
  "entry": {
    "key": "api_key",
    "encrypted": "base64...",
    "iv": "base64..."
  }
}
```

### POST `/v1/vault/decrypt`
Decrypt a provided vault entry.

Auth: required

Request:
```json
{
  "entry": {
    "key": "api_key",
    "encrypted": "base64...",
    "iv": "base64..."
  }
}
```

Response:
```json
{
  "ok": true,
  "plaintext": "secret-value"
}
```

### GET `/v1/vault/entries?key=<optional>`
List persisted encrypted entries (plus integrity check result).

Auth: required

Response:
```json
{
  "ok": true,
  "count": 1,
  "entries": [
    {
      "key": "api_key",
      "encrypted": "base64...",
      "iv": "base64...",
      "integrityOk": true
    }
  ]
}
```

---

## 4) Session Event API

### GET `/v1/sessions`
List known sessions.

Auth: required

Response:
```json
{
  "sessions": [
    { "id": "sess_1", "createdAt": "..." }
  ]
}
```

### GET `/v1/sessions/:sessionId/events`
List generation events for one session.

Auth: required

Response:
```json
{
  "sessionId": "sess_1",
  "events": [
    {
      "id": "gen_1",
      "providerUsed": "ollama",
      "modelUsed": "qwen2.5:7b",
      "timingMs": 400,
      "requestId": "..."
    }
  ]
}
```

---

## 5) Memory Layer API (OpenClaw integration)

### POST `/api/journal`
Append journal block to chain (default chain: `journal`).

Request:
```json
{
  "content": "Today I decided...",
  "tags": ["decision", "ops"],
  "chain": "journal"
}
```

Response:
```json
{ "ok": true, "index": 42, "hash": "abc123" }
```

### POST `/api/recall`
Semantic recall over embeddings.

Request:
```json
{ "query": "recent deployment issues", "limit": 10 }
```

Response:
```json
{
  "ok": true,
  "results": {
    "query": "recent deployment issues",
    "count": 2,
    "hits": [
      { "id": "journal-1", "score": 0.91, "text_preview": "..." }
    ]
  }
}
```

### POST `/api/decide`
Append structured decision block.

Request:
```json
{
  "title": "Choose default provider",
  "content": "Use ollama in dev",
  "tags": ["architecture", "provider"]
}
```

Response:
```json
{ "ok": true, "index": 7, "hash": "def456" }
```

---

## Gateway API Endpoints (`src/gateway/server.ts`)

### GET `/health`
Gateway probe.

### GET `/status`
System status with chain/data dirs.

### GET `/metrics`
Gateway metrics snapshot.

### GET `/ops/status`
Gateway operational status including providers.

### GET `/providers`
Provider health + default provider.

### POST `/provider/chat`
Gateway-level chat generation.

Request:
```json
{
  "input": "hello",
  "provider": "auto",
  "model": "optional",
  "sessionId": "optional"
}
```

### POST `/exec`
Execute shell command under gateway policy.

Request:
```json
{
  "command": "ls -la",
  "cwd": "/tmp",
  "timeout": 5000
}
```

Notes:
- Protected by special exec auth + policy checks.
- Security audit events are written for attempts.

---

## MCP HTTP Transport Endpoint

From `src/mcp/transport/http.ts`:

### `/mcp` (POST/GET/DELETE)
- JSON-RPC streamable MCP transport endpoint
- Session via `mcp-session-id` header

Error examples:
- `400` invalid session
- `400` parse error (`-32700`)
- `405` method not allowed

---

## Dashboard HTTP Endpoints

From `src/dashboard/web-dashboard.ts`:
- `GET /` or `/index.html` (HTML UI)
- `GET /api/data` (dashboard JSON)
- `GET /api/health` (dashboard health)

---

## End-to-end Examples

### curl

```bash
export BASE_URL="http://127.0.0.1:3000"
export TOKEN="your_token"

curl -sS "$BASE_URL/v1/chat/generate" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"input":"Summarize latest decisions","provider":"auto","strategy":"default"}'
```

### JavaScript (fetch)

```js
const res = await fetch('http://127.0.0.1:3000/v1/vault/encrypt', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.MEMPHIS_API_TOKEN}`,
  },
  body: JSON.stringify({ key: 'demo', plaintext: 'secret' }),
});

const json = await res.json();
console.log(json);
```

### Python (requests)

```python
import requests

base = "http://127.0.0.1:3000"
token = "your_token"

r = requests.post(
    f"{base}/api/recall",
    headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    },
    json={"query": "vault initialization", "limit": 5},
    timeout=30,
)

print(r.status_code)
print(r.json())
```
