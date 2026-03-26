# Memphis API Reference

Version scope: `@memphis-chains/memphis` `0.3.5` (current repo state)

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
- `/api/model-d/proposals`
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

### Health endpoint map (important)

There are multiple health endpoints exposed by different servers/components:

- **Main HTTP API server**: `GET /health` (base default `http://127.0.0.1:3000`)
- **Gateway server**: `GET /health` (gateway host/port)
- **Dashboard UI server**: `GET /api/health` (dashboard-specific endpoint)

Use `GET /health` for service/process liveness on the API/gateway.  
Use `GET /api/health` only when targeting the dashboard web server.

### GET `/health`

Main HTTP API health probe.

Auth: public

Response (200 healthy or 503 degraded):

```json
{
  "status": "healthy",
  "service": "memphis",
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
  "service": "memphis",
  "version": "0.3.5",
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

**Two request paths:**

#### Path 1: `messages[]` (new — full chat API)

Use this for conversation-based calls with message history and tool support.

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "systemPrompt": "string (optional, overrides any system message in messages)",
  "userId": "string (optional)",
  "tools": [
    {
      "name": "tool_name",
      "description": "Does something",
      "inputSchema": { "type": "object", "properties": {} }
    }
  ],
  "provider": "auto|ollama (optional, default: auto)",
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

Response (same shape as below, plus optional `usage` token counts):

```json
{
  "id": "gen_...",
  "providerUsed": "ollama",
  "modelUsed": "qwen2.5-coder:3b",
  "output": "Generated text",
  "usage": {
    "inputTokens": 100,
    "outputTokens": 230
  },
  "timingMs": 531
}
```

#### Path 2: `input` (legacy — task queue path)

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

Response (with trace for task-queue path):

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
  "sessions": [{ "id": "sess_1", "createdAt": "..." }]
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

## 5) Memory Layer API (durable memory and downstream integrations)

### POST `/api/journal`

Append journal block to chain via `storeDurableMemory()` — atomically writes to both the chain (audit source of truth) and the Rust embed index (recall acceleration).

Chain name is validated against path traversal rules. Security audit events are written for all append attempts.

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
{
  "ok": true,
  "index": 42,
  "hash": "abc123",
  "memoryId": "journal-42",
  "indexed": true
}
```

Notes:
- `memoryId` is the embed store ID (auto-generated as `journal-{index}` if not provided)
- `indexed` is `true` if embed store accepted the entry; embed failures do not fail the chain write
- Chain name must match `^[A-Za-z0-9_-]{1,64}$` and resolve to a safe path under the chains directory

### POST `/api/recall`

Semantic recall over the Rust embed index. Supports tag-based filtering and user-scoped results.

Request:

```json
{
  "query": "recent deployment issues",
  "limit": 10,
  "tags": ["ops", "infrastructure"],
  "userId": "user_abc"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `query` | string | Required, 1-200 chars |
| `limit` | int | 1-100, default 10 |
| `tags` | string[] | Optional filter: only entries matching any of these tags |
| `userId` | string | Optional: results are filtered to entries tagged with `[userId]` |

Response:

```json
{
  "ok": true,
  "results": {
    "query": "recent deployment issues",
    "count": 2,
    "hits": [{ "id": "journal-1", "score": 0.91, "text_preview": "..." }]
  }
}
```

Notes:
- Tag filtering uses intersection (entries must have at least one matching tag)
- When `userId` is provided, limit is fetched 3× larger server-side then filtered to entries containing `[userId]`
- All recall queries emit security audit events

### POST `/api/search`

Exact phrase recall over the derived SQLite FTS5 index. Use this for "where is X mentioned?" lookups.

Request:

```json
{
  "query": "vault pepper rotation",
  "limit": 10,
  "chain": "journal",
  "userId": "user_abc"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `query` | string | Required exact phrase |
| `limit` | int | 1-100, default 10 |
| `chain` | string | Optional chain filter (`journal`, `decisions`, `patterns`, `reflections`, `proactive`) |
| `userId` | string | Optional: results are filtered to entries containing `[userId]` |

Response:

```json
{
  "ok": true,
  "results": {
    "query": "vault pepper rotation",
    "count": 1,
    "hits": [
      {
        "sourceKey": "journal:42",
        "chain": "journal",
        "blockIndex": 42,
        "snippet": "We decided to rotate the [vault pepper rotation] window this quarter"
      }
    ]
  }
}
```

Notes:
- Exact search is FTS5-backed derived state, rebuildable from durable chain content
- Exact recall complements semantic recall; it does not replace `/api/recall`
- All exact-search queries emit security audit events

### POST `/api/model-d/proposals`

Receive a remote Model D proposal and return this node's vote.

Auth: required (when `MEMPHIS_API_TOKEN` is configured)

Request:

```json
{
  "protocol": "memphis-model-d/v1",
  "from": { "id": "peer-agent-a", "name": "Peer A" },
  "to": { "id": "local-agent-1" },
  "proposal": {
    "id": "proposal-123",
    "title": "Harden CI gate",
    "description": "Enable strict checks and keep quality gate mandatory.",
    "proposer": "peer-agent-a",
    "type": "strategic",
    "status": "voting",
    "createdAt": "2026-03-12T07:30:00.000Z"
  }
}
```

Response:

```json
{
  "ok": true,
  "protocol": "memphis-model-d/v1",
  "proposalId": "proposal-123",
  "receiver": { "id": "local-agent-1", "name": "Memphis Node" },
  "vote": {
    "choice": "approve",
    "reason": "proposal aligns with reliability and security priorities"
  },
  "receivedAt": "2026-03-12T07:30:01.000Z"
}
```

Notes:

- The endpoint validates payload shape and protocol.
- If `MEMPHIS_MODEL_D_AGENT_ID` is set and `to.id` does not match, request is rejected (`409`).
- Votes are persisted to `collective` chain when storage is available.

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
- Malformed JSON bodies return `400` with `{ "error": "..." }`.
- Channel gateway (Telegram) is opt-in via `MEMPHIS_CHANNEL_GATEWAY_ENABLED`. When enabled, requires `MEMPHIS_TELEGRAM_BOT_TOKEN`. Optional user allowlist via `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS` (comma-separated).

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
- `GET /api/health` (dashboard health; **not** the same as API/gateway `/health`)

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
