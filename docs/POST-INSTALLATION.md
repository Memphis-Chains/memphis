# Memphis v5 Post-Installation Guide 🚀

After install/build, complete this checklist to make Memphis production-ready.

Related docs: [OLLAMA-SETUP.md](./OLLAMA-SETUP.md) · [TESTING-VERIFICATION.md](./TESTING-VERIFICATION.md) · [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md)

---

## 1) First configuration

```bash
memphis setup
memphis configure
```

Expected output (example):
```text
[ok] configuration written
[ok] provider selected
```

If CLI subcommands differ in your build, run:
```bash
memphis --help
```

---

## 2) Environment variables (`.env`)

Create/update `.env` in repo root:

```bash
cat > .env <<'ENV'
MEMPHIS_PROVIDER=ollama
MEMPHIS_EMBEDDING_PROVIDER=ollama
MEMPHIS_EMBEDDING_MODEL=nomic-embed-text
MEMPHIS_OLLAMA_BASE_URL=http://127.0.0.1:11434
MEMPHIS_LOG_LEVEL=info
# Optional cloud providers:
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
ENV
```

Load for current shell:
```bash
set -a; source .env; set +a
```

---

## 3) Provider selection

Supported strategy examples:
- ✅ `ollama` (local-first)
- ✅ `openai`
- ✅ `anthropic`
- ✅ `local-fallback` (resilience fallback)
- ✅ Hybrid chain (cloud LLM + local embeddings)

Example:
```bash
memphis configure --provider ollama --embedding-provider ollama
```

---

## 4) Embedding model setup

```bash
ollama pull nomic-embed-text
memphis configure --embedding-model nomic-embed-text
```

Sanity check:
```bash
memphis health
```

Expected output:
```text
status: ok
embedding: ready
```

---

## 5) Vault initialization

```bash
memphis vault init
memphis vault list
```

Expected output:
```text
vault: initialized
```

---

## 6) Backup configuration

Example daily backup script invocation:

```bash
mkdir -p backups
memphis vault export --out backups/vault-$(date +%F).json
```

Optional cron sample:
```bash
0 3 * * * cd /path/to/memphis && memphis vault export --out backups/vault-$(date +\%F).json
```

---

## 7) Test basic commands

```bash
memphis --version
memphis health
memphis ask --input "Say hello from Memphis"
```

Expected output pattern:
```text
vX.Y.Z
status: ok
<assistant response>
```

---

## 8) Next steps

1. Run full validation: [TESTING-VERIFICATION.md](./TESTING-VERIFICATION.md)
2. Configure OpenClaw plugin: [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md)
3. Choose a deployment profile: [QUICK-START-SCENARIOS.md](./QUICK-START-SCENARIOS.md)
