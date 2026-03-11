# Memphis v5 Quick-Start Scenarios ⚡

Pick the scenario that matches your environment.

Related docs: [PREREQUISITES.md](./PREREQUISITES.md) · [POST-INSTALLATION.md](./POST-INSTALLATION.md) · [OPENCLAW-INTEGRATION.md](./OPENCLAW-INTEGRATION.md)

---

## Scenario 1: Local-only (no external APIs)

```bash
cp .env.example .env
cat >> .env <<'ENV'
MEMPHIS_PROVIDER=local-fallback
MEMPHIS_EMBEDDING_PROVIDER=local-fallback
ENV
npm install
npm run build
npm link
memphis health
```

Expected: basic CLI operations work without cloud keys.

---

## Scenario 2: Ollama-only (embeddings + chat)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull nomic-embed-text
ollama pull llama3.1:8b
cat > .env <<'ENV'
MEMPHIS_PROVIDER=ollama
MEMPHIS_EMBEDDING_PROVIDER=ollama
MEMPHIS_EMBEDDING_MODEL=nomic-embed-text
MEMPHIS_OLLAMA_BASE_URL=http://127.0.0.1:11434
ENV
memphis health
memphis ask --input "Hello from Ollama-only scenario"
```

Expected: local inference + embedding path active.

---

## Scenario 3: Cloud provider (OpenAI / Anthropic)

```bash
cat > .env <<'ENV'
MEMPHIS_PROVIDER=openai
OPENAI_API_KEY=your_key_here
# or:
# MEMPHIS_PROVIDER=anthropic
# ANTHROPIC_API_KEY=your_key_here
MEMPHIS_EMBEDDING_PROVIDER=openai
ENV
memphis health
memphis ask --input "Cloud provider verification"
```

Expected: cloud-backed responses.

---

## Scenario 4: Hybrid (local Ollama + cloud LLM)

```bash
ollama pull nomic-embed-text
cat > .env <<'ENV'
MEMPHIS_PROVIDER=openai
OPENAI_API_KEY=your_key_here
MEMPHIS_EMBEDDING_PROVIDER=ollama
MEMPHIS_EMBEDDING_MODEL=nomic-embed-text
MEMPHIS_OLLAMA_BASE_URL=http://127.0.0.1:11434
ENV
memphis embed store --text "Hybrid mode test"
memphis ask --input "Use indexed context if available"
```

Expected: cloud reasoning + local embedding retrieval.

---

## Scenario 5: Multi-provider setup

```bash
cat > .env <<'ENV'
MEMPHIS_PROVIDER=local-fallback
MEMPHIS_PROVIDER_CHAIN=ollama,openai,local-fallback
OPENAI_API_KEY=your_key_here
MEMPHIS_EMBEDDING_PROVIDER=ollama
MEMPHIS_EMBEDDING_MODEL=nomic-embed-text
MEMPHIS_OLLAMA_BASE_URL=http://127.0.0.1:11434
ENV
memphis configure
memphis health
```

Expected: resilient fallback behavior if one provider is unavailable.

---

## Troubleshooting quick pointers

- CLI unavailable → `npm link`
- Ollama unreachable → `systemctl status ollama`
- Bad provider key → verify `.env`

See full tree: [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)
