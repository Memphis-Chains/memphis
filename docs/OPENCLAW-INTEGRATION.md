# OpenClaw Integration with Memphis v5 🔌

Connect Memphis memory capabilities into OpenClaw workflows.

Related docs: [POST-INSTALLATION.md](./POST-INSTALLATION.md) · [QUICK-START-SCENARIOS.md](./QUICK-START-SCENARIOS.md)

---

## 1) Install OpenClaw

```bash
npm install -g openclaw
openclaw --version
```

Expected output:
```text
openclaw x.y.z
```

---

## 2) Install Memphis memory plugin

```bash
openclaw plugin install memphis-memory
openclaw plugins | grep -i memphis
```

Expected output:
```text
memphis-memory   enabled
```

---

## 3) Configure memory provider (`openclaw.json`)

Create/update `~/.openclaw/openclaw.json`:

```json
{
  "memory": {
    "provider": "memphis",
    "memphis": {
      "baseUrl": "http://127.0.0.1:7777",
      "index": "default",
      "embeddingProvider": "ollama",
      "embeddingModel": "nomic-embed-text"
    }
  }
}
```

⚠️ Adjust `baseUrl` to your actual Memphis runtime endpoint.

---

## 4) Usage examples

### Index memory
```bash
openclaw memory index --text "Memphis + OpenClaw integration test"
```

### Search memory
```bash
openclaw memory search "integration test"
```

### Health check
```bash
openclaw memory doctor
```

Expected output pattern:
```text
provider: memphis
status: ok
results: [...]
```

---

## 5) Troubleshooting plugin issues

- Plugin not found:
  ```bash
  openclaw plugins
  ```
- Provider misconfigured:
  ```bash
  cat ~/.openclaw/openclaw.json
  ```
- Runtime not reachable:
  ```bash
  curl -s http://127.0.0.1:7777/health || true
  ```
- Ollama dependency errors: see [OLLAMA-SETUP.md](./OLLAMA-SETUP.md)

---

## 6) Alternative configuration examples

### Local fallback only
```json
{
  "memory": {
    "provider": "local-fallback"
  }
}
```

### Hybrid (cloud LLM + local embeddings)
```json
{
  "memory": {
    "provider": "memphis",
    "memphis": {
      "llmProvider": "openai",
      "embeddingProvider": "ollama",
      "embeddingModel": "nomic-embed-text"
    }
  }
}
```
