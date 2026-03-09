# PRODUCTION_ENV_TEMPLATE

Use this as a checklist/template when preparing `.env.production.local`.

```bash
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info

MEMPHIS_API_TOKEN=<generate-strong-token>

# Choose one provider mode as DEFAULT_PROVIDER
DEFAULT_PROVIDER=shared-llm
# DEFAULT_PROVIDER=decentralized-llm
# DEFAULT_PROVIDER=local-fallback   # smoke/temporary only

# shared-llm mode (required when DEFAULT_PROVIDER=shared-llm)
SHARED_LLM_API_BASE=https://...
SHARED_LLM_API_KEY=...

# decentralized-llm mode (required when DEFAULT_PROVIDER=decentralized-llm)
DECENTRALIZED_LLM_API_BASE=https://...
DECENTRALIZED_LLM_API_KEY=...

LOCAL_FALLBACK_ENABLED=true

GEN_TIMEOUT_MS=30000
GEN_MAX_TOKENS=512
GEN_TEMPERATURE=0.4

# Must point to persistent storage path in production
DATABASE_URL=file:/var/lib/memphis-v4/memphis-v4.db

# Vault policy
MEMPHIS_VAULT_PEPPER=<min-12-chars-strong-secret>

# Optional local alert webhook for nightly smoke failures
OLLAMA_SMOKE_ALERT_WEBHOOK=
```

## Notes
- `DATABASE_URL` in production must be persistent (not tmp, not ephemeral workspace path).
- Keep `.env.production.local` out of git.
- Rotate tokens/keys if they were exposed in logs or shell history.
