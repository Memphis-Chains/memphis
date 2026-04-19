# Memphis Quick-Start Scenarios

Pick the scenario that matches your runtime after the canonical first-run:

```bash
npm run bootstrap
memphis init
```

Related docs: [GETTING-STARTED.md](./GETTING-STARTED.md) · [POST-INSTALLATION.md](./POST-INSTALLATION.md)

## Scenario 1: Local-only baseline

Keep the defaults written by `bootstrap` / `init`:

- `DEFAULT_PROVIDER=local-fallback`
- `LOCAL_FALLBACK_ENABLED=true`
- `RUST_EMBED_MODE=local`

Expected result: basic CLI/TUI/HTTP flows work without external keys.

## Scenario 2: Ollama-local

After `bootstrap`, edit `.env` to use the local Ollama provider values written by
the setup flow, then confirm:

```bash
memphis health --json
memphis ask --input "Hello from Ollama-local scenario"
```

Expected result: local embeddings and Ollama-local mode are available when
Ollama is reachable.

## Scenario 3: Shared remote LLM

After `init`, add the matching `.env` values:

- `DEFAULT_PROVIDER=shared-llm`
- `SHARED_LLM_API_BASE=...`
- `SHARED_LLM_API_KEY=...`

Then verify:

```bash
memphis providers:health --json
memphis ask --input "Cloud provider verification"
```

## Scenario 4: Hybrid

Use a remote `DEFAULT_PROVIDER` together with local or Ollama embeddings in
`.env`, then verify:

```bash
memphis embed store --id hybrid-1 --value "Hybrid mode test"
memphis ask --input "Use indexed context if available"
```

## Scenario 5: Optional Matrix pilot

This is not part of canonical first-run:

```bash
memphis setup matrix --json
```

Expected result: truthful pilot output with vault-backed token references when a
real Matrix access token exists.

## Troubleshooting quick pointers

- first-run not complete -> `memphis init status --json`
- degraded runtime -> `memphis repair runtime`
- provider issues -> `memphis providers:health --json`

See full tree: [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)
