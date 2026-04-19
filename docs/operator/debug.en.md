# Memphis Debug Playbook (EN)

> Symptom → Diagnosis → Fix tree for Memphis runtime issues.
> Polish version: [`debug.pl.md`](./debug.pl.md).
> Install issues: see [`install.en.md`](./install.en.md).

> ⚠️ **Verify exact subcommand syntax.** Top-level commands (`memphis health`,
> `memphis vault`, `memphis chain`, etc.) are confirmed against the v1.3.0
> CLI dispatcher (`src/infra/cli/registry.ts`). Subcommand forms shown
> below reflect common usage patterns and may differ — always cross-check
> with `memphis <command> --help`.

---

## First-line tools

Run these first; they catch most issues:

```bash
memphis health                     # is the daemon up + reachable?
memphis health --json              # machine-readable; includes offline mode
memphis doctor                     # full pre-flight check
memphis service status             # systemd service state
memphis service logs -n 100        # recent daemon logs
memphis tui --check-only --json    # TUI cockpit boot-test
```

If `memphis health` returns `status: ok` and `memphis doctor` shows all green, you don't have a runtime problem — check application-layer issues (vault, chains, providers).

---

## Symptom → diagnosis → fix

### Daemon won't start

| Symptom                                          | Diagnosis                                 | Fix                                                                                                                                |
| ------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `memphis service start` exits with no output     | systemd not enabled                       | `systemctl --user enable memphis` then retry                                                                                       |
| `Connection refused on :3000` after start        | daemon crashed early                      | `memphis service logs -n 200` → look for first ERROR                                                                               |
| `EADDRINUSE: address already in use :3000`       | another process bound :3000               | `lsof -i :3000` → kill rogue process or change `MEMPHIS_HTTP_PORT`                                                                 |
| `Loop detected: boot-failure threshold exceeded` | runtime crashed 5×; auto-revert kicked in | `memphis service logs -n 500` → diagnose; `memphis evolve --help` for self-modify rollback options if a recent evolution caused it |
| Daemon starts but immediately exits              | unhandled exception during init           | `MEMPHIS_DEBUG=1 memphis service start` for verbose trace                                                                          |

### Vault won't unlock

| Symptom                                   | Diagnosis                              | Fix                                                                                                                                   |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `vault unlock failed: invalid passphrase` | typo or wrong passphrase               | retry; if forgotten use recovery                                                                                                      |
| `recovery answer mismatch`                | answer hashed differently than at init | answers are case-sensitive after Argon2id; try variations. Recovery flow: see `memphis vault --help` for recovery-related subcommands |
| `vault corrupt: checksum mismatch`        | disk error                             | restore from backup — see `memphis backup --help` for restore flags                                                                   |
| `vault not initialized`                   | `memphis init` never ran               | run `memphis init`                                                                                                                    |
| `vault locked after rotation`             | tmp files not fsynced (pre-#145 bug)   | upgrade to v1.3.0+; `memphis vault rotate` retry                                                                                      |

### Chain integrity errors

| Symptom                          | Diagnosis                                                 | Fix                                                                                                                                |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `chain hash mismatch at block N` | block content edited or disk error                        | `memphis repair runtime --fix` for derived state; for canonical chain corruption restore from backup                               |
| `chain integrity degraded`       | one or more invalid blocks detected                       | Use `memphis chain --help` to find the audit/repair subcommands available in your version (chain audit + chain repair are typical) |
| `signature verification failed`  | unsigned block where `RUST_CHAIN_REQUIRE_SIGNATURES=true` | check `RUST_CHAIN_SIGNER_KEY_HEX` is set; or set `MEMPHIS_SYNC_ACCEPT_UNSIGNED=true` for legacy migration                          |
| `append-lock timeout`            | another process holds the lock                            | `lsof ~/.memphis/chains/.append.lock` → kill blocker; lock auto-releases on process exit                                           |

### Provider / chat issues

| Symptom                               | Diagnosis                  | Fix                                                                                                                                               |
| ------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Rate limit exceeded` (429)           | provider quota             | wait `retryAfterMs` from response, or switch provider: `memphis config set DEFAULT_PROVIDER local-fallback`                                       |
| `Provider unauthorized` (401)         | API key missing or invalid | `memphis vault add <PROVIDER>_API_KEY` (vault-first) or set env var                                                                               |
| `Ollama unreachable`                  | daemon not running         | `ollama serve &` or `systemctl --user start ollama`                                                                                               |
| `Model not found: cogito:3b`          | model not pulled           | `ollama pull cogito:3b`                                                                                                                           |
| `Circuit breaker tripped: <provider>` | 5+ consecutive failures    | Restart the daemon (`memphis service restart`) to reset the breaker; verify state via `memphis providers list --json`; check provider status page |
| `Cost cap reached`                    | budget exhausted           | `memphis config show COST_CAP_*` then adjust, or wait for reset window                                                                            |

### Search / recall issues

| Symptom                          | Diagnosis                     | Fix                                                                                |
| -------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `memphis recall` returns nothing | embeddings not built          | `memphis search rebuild`                                                           |
| Empty results for known content  | exact-search index drift      | `memphis repair --help` for rebuild-search options                                 |
| `embedding dimension mismatch`   | model changed without rebuild | rebuild via `memphis search --help` (rebuild subcommand) or `memphis embed --help` |
| Slow search (>10s)               | unindexed corpus              | rebuild search index; verify `RUST_EMBED_MODE=local` for ONNX path                 |

### Telegram surface

| Symptom                    | Diagnosis                  | Fix                                                                            |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| Bot doesn't respond        | bot token missing or wrong | `memphis vault add MEMPHIS_TELEGRAM_BOT_TOKEN`; restart                        |
| `User ID not in allowlist` | sender not authorized      | add user ID to `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS`                             |
| Voice messages fail        | TTS/STT not configured     | check Google Cloud TTS env or use text mode                                    |
| Smoke test fails in CI     | bot token expired          | regenerate via @BotFather; update CI secret `MEMPHIS_TELEGRAM_SMOKE_BOT_TOKEN` |

### Self-modification

| Symptom                                   | Diagnosis                                       | Fix                                                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tier-3 session required`                 | running tier-3 op without elevation             | Tier-3 elevation is prompted automatically when invoking a tier-3 tool. For non-interactive flows set `MEMPHIS_OPERATOR_PASSPHRASE` env var. See `memphis operator --help` for related commands. |
| `Test gate failed`                        | self-modify branch tests didn't pass            | review proposed diff, fix tests, retry                                                                                                                                                           |
| `Boot-failure auto-revert triggered`      | post-self-modify boot crashed                   | last self-modify was reverted; inspect history via `memphis evolve --help`                                                                                                                       |
| `path validation failed: outside sandbox` | self-modify tried to write outside `~/memphis/` | by design — operator passphrase + tier-3 won't bypass                                                                                                                                            |

### Performance

| Symptom                  | Diagnosis                                  | Fix                                                                                 |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Slow startup (>30s)      | first build cold                           | second start should be <5s; if not, check `cargo target/` cache integrity           |
| High CPU on idle         | embedding rebuild loop                     | force one-shot rebuild (see `memphis search --help`) then `memphis service restart` |
| Memory growth over hours | known: vitest test harness leak (not prod) | n/a in production                                                                   |
| Slow chat response       | non-streaming provider                     | use streaming provider (Ollama, Anthropic)                                          |

---

## Log locations

| Log                  | Path                                                                     | Format             |
| -------------------- | ------------------------------------------------------------------------ | ------------------ |
| Daemon stdout/stderr | `journalctl --user -u memphis` (systemd) or `~/.memphis/logs/daemon.log` | pino JSON          |
| Security audit       | `~/.memphis/data/security-audit.jsonl`                                   | JSONL, append-only |
| Chain blocks         | `~/.memphis/chains/<name>/<index>.json`                                  | JSON, append-only  |
| Boot failures        | `~/.memphis/state/boot-failures.json`                                    | JSON state         |
| Vault state          | `~/.memphis/vault/vault-state.json`                                      | encrypted JSON     |
| Vault entries        | `~/.memphis/vault/vault-entries.json`                                    | encrypted JSON     |
| TUI state            | `~/.config/memphis/tui-state.json`                                       | JSON               |

To follow live: `journalctl --user -u memphis -f` (Linux) or `tail -F ~/.memphis/logs/daemon.log`.

---

## Diagnostic dumps

For filing an issue, attach (some commands may need slight subcommand
adjustments — verify with `memphis <command> --help`):

```bash
memphis health --json > memphis-health.json
memphis doctor --json > memphis-doctor.json
memphis service logs -n 500 > memphis-logs.txt
memphis providers list --json > memphis-providers.json
memphis --version > memphis-version.txt
# Plus any chain / audit dumps via `memphis chain --help` and `memphis audit --help`
```

**Sanitize before sharing publicly:**

- Remove API keys (grep -E 'sk-|api_key|token|password')
- Remove vault entries content (encrypted but content metadata can leak)
- Remove personal identifiers from chain blocks if present

---

## Filing an issue

1. Run diagnostic dumps above
2. Open: https://github.com/Memphis-Chains/memphis/issues/new
3. Include:
   - Memphis version (`memphis --version`)
   - OS + kernel (`uname -a`)
   - Node version (`node -v`)
   - Rust version (`rustc --version`)
   - Reproduction steps
   - Sanitized log excerpt around the failure
   - Sanitized health/doctor JSON

---

## When all else fails — clean reinstall

Last resort (loses all chains + vault):

```bash
memphis service stop
rm -rf ~/.memphis ~/.config/memphis
memphis init    # fresh state
```

To preserve chains for archival before wipe:

```bash
cp -r ~/.memphis/chains ~/memphis-chains-backup-$(date -Idate)
```

---

## Related docs

- **Install:** [`install.en.md`](./install.en.md)
- **CLI reference:** [`CLI-REFERENCE.md`](./CLI-REFERENCE.md)
- **Disaster recovery:** [`disaster-recovery.md`](./disaster-recovery.md)
- **Tier-3 runbook:** [`tier3-runbook.md`](./tier3-runbook.md)
- **Architecture (developers):** [`../dev/CANONICAL-ARCHITECTURE.md`](../dev/CANONICAL-ARCHITECTURE.md)

---

_Last verified: 2026-04-19 against Memphis v1.3.0 runtime behavior + `src/infra/cli/registry.ts` dispatcher. Top-level commands confirmed real (in registry as of v1.3.0): `health`, `doctor`, `service`, `tui`, `chat`, `ask`, `vault`, `chain`, `search`, `embed`, `evolve`, `providers`, `repair`, `init`, `mcp`, `telegram`, `trust`, `audit`, `worker`, `secret`, `schedule`, `kill-zombies`, `backup`, `self-update`, `restart`, `setup`, `configure`, `deploy`, `operator`. Subcommand syntax may evolve — verify with `memphis <command> --help`._
