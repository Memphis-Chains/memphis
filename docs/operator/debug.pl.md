# Playbook Debugowania Memphis (PL)

> Drzewo Symptom → Diagnoza → Naprawa dla problemów runtime'owych Memphis.
> Wersja angielska: [`debug.en.md`](./debug.en.md).
> Problemy z instalacją: [`install.pl.md`](./install.pl.md).

> ⚠️ **Weryfikuj dokładną składnię subcommand'ów.** Top-level commands
> (`memphis health`, `memphis vault`, `memphis chain`, itp.) potwierdzone
> względem dispatcher'a CLI v1.3.0 (`src/infra/cli/registry.ts`). Formy
> subcommand'ów pokazane poniżej odzwierciedlają typowe wzorce użycia
> i mogą się różnić — zawsze sprawdzaj `memphis <command> --help`.

---

## Pierwsza linia narzędzi

Uruchom najpierw te; łapią większość problemów:

```bash
memphis health                     # czy daemon działa i odpowiada?
memphis health --json              # maszynowo, łącznie z trybem offline
memphis doctor                     # pełna pre-flight weryfikacja
memphis service status             # stan usługi systemd
memphis service logs -n 100        # ostatnie logi daemona
memphis tui --check-only --json    # boot-test cockpitu TUI
```

Jeśli `memphis health` zwraca `status: ok` i `memphis doctor` jest zielony — nie masz problemu runtime'owego. Sprawdź warstwę aplikacji (sejf, łańcuchy, providery).

---

## Symptom → diagnoza → naprawa

### Daemon nie startuje

| Symptom                                          | Diagnoza                          | Naprawa                                                                                                                  |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `memphis service start` kończy bez output'u      | systemd nie włączony              | `systemctl --user enable memphis` i ponów                                                                                |
| `Connection refused on :3000` po starcie         | daemon się rozsypał wcześnie      | `memphis service logs -n 200` → szukaj pierwszego ERROR                                                                  |
| `EADDRINUSE: address already in use :3000`       | inny proces zajmuje :3000         | `lsof -i :3000` → zabij rogue proces lub zmień `MEMPHIS_HTTP_PORT`                                                       |
| `Loop detected: boot-failure threshold exceeded` | runtime crashował 5×; auto-revert | `memphis service logs -n 500` → diagnoza; `memphis evolve --help` dla opcji rollback self-modify jeśli niedawna ewolucja |
| Daemon startuje i od razu kończy                 | nieobsłużony wyjątek przy init    | `MEMPHIS_DEBUG=1 memphis service start` dla verbose stack                                                                |

### Sejf się nie otwiera

| Symptom                                   | Diagnoza                                   | Naprawa                                                                                             |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `vault unlock failed: invalid passphrase` | literówka lub złe hasło                    | ponów; jeśli zapomniane — odzyskiwanie                                                              |
| `recovery answer mismatch`                | odpowiedź zhashowana inaczej niż przy init | odpowiedzi case-sensitive po Argon2id; spróbuj wariantów. Flow odzyskiwania: `memphis vault --help` |
| `vault corrupt: checksum mismatch`        | błąd dysku                                 | przywróć z backupu — `memphis backup --help` dla flag restore                                       |
| `vault not initialized`                   | `memphis init` nigdy nie uruchomione       | uruchom `memphis init`                                                                              |
| `vault locked after rotation`             | tmp files nie fsynced (bug pre-#145)       | upgrade do v1.3.0+; `memphis vault rotate` ponów                                                    |

### Błędy integralności łańcucha

| Symptom                          | Diagnoza                                                    | Naprawa                                                                                          |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `chain hash mismatch at block N` | blok edytowany lub błąd dysku                               | `memphis repair runtime --fix` dla pochodnych; dla canonical chain — przywróć z backupu          |
| `chain integrity degraded`       | jeden lub więcej niepoprawnych bloków                       | `memphis chain --help` dla dostępnych w Twojej wersji subcommandów audit/repair                  |
| `signature verification failed`  | niepodpisany blok przy `RUST_CHAIN_REQUIRE_SIGNATURES=true` | sprawdź `RUST_CHAIN_SIGNER_KEY_HEX`; lub `MEMPHIS_SYNC_ACCEPT_UNSIGNED=true` dla migracji legacy |
| `append-lock timeout`            | inny proces trzyma lock                                     | `lsof ~/.memphis/chains/.append.lock` → zabij blockera; lock uwalnia się przy exit               |

### Provider / chat

| Symptom                               | Diagnoza                     | Naprawa                                                                                                                              |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Rate limit exceeded` (429)           | quota providera              | poczekaj `retryAfterMs`, lub przełącz: `memphis config set DEFAULT_PROVIDER local-fallback`                                          |
| `Provider unauthorized` (401)         | API key brak lub niepoprawny | `memphis vault add <PROVIDER>_API_KEY` (vault-first) lub env var                                                                     |
| `Ollama unreachable`                  | daemon nie działa            | `ollama serve &` lub `systemctl --user start ollama`                                                                                 |
| `Model not found: cogito:3b`          | model nie pobrany            | `ollama pull cogito:3b`                                                                                                              |
| `Circuit breaker tripped: <provider>` | 5+ błędów z rzędu            | Restart daemona (`memphis service restart`) resetuje breaker; weryfikacja: `memphis providers list --json`; sprawdź status providera |
| `Cost cap reached`                    | budżet wyczerpany            | `memphis config show COST_CAP_*` i dostosuj, lub czekaj na reset                                                                     |

### Wyszukiwanie / recall

| Symptom                        | Diagnoza                    | Naprawa                                                                               |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| `memphis recall` zwraca pusto  | embeddingi nie zbudowane    | `memphis search rebuild`                                                              |
| Pusto przy znanej zawartości   | drift indeksu exact-search  | `memphis repair --help` dla opcji rebuild-search                                      |
| `embedding dimension mismatch` | zmieniono model bez rebuild | rebuild przez `memphis search --help` (subcommand rebuild) lub `memphis embed --help` |
| Wolne wyszukiwanie (>10s)      | nieindeksowany korpus       | rebuild indeksu search; zweryfikuj `RUST_EMBED_MODE=local` dla ścieżki ONNX           |

### Surface Telegram

| Symptom                         | Diagnoza                   | Naprawa                                                                         |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------- |
| Bot nie odpowiada               | brak lub złego token       | `memphis vault add MEMPHIS_TELEGRAM_BOT_TOKEN`; restart                         |
| `User ID not in allowlist`      | nadawca nieautoryzowany    | dodaj user ID do `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS`                            |
| Wiadomości głosowe nie działają | TTS/STT nie skonfigurowane | sprawdź Google Cloud TTS env lub używaj tekst                                   |
| Smoke test fail w CI            | bot token wygasł           | regeneruj przez @BotFather; update CI secret `MEMPHIS_TELEGRAM_SMOKE_BOT_TOKEN` |

### Self-modyfikacja

| Symptom                                   | Diagnoza                                       | Naprawa                                                                                                                                                               |
| ----------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tier-3 session required`                 | tier-3 op bez elewacji                         | Tier-3 elewacja jest pytana automatycznie przy wywołaniu tier-3 toola. Dla flow non-interactive ustaw `MEMPHIS_OPERATOR_PASSPHRASE`. Patrz `memphis operator --help`. |
| `Test gate failed`                        | branch self-modify nie zdał testów             | review diff, popraw testy, ponów                                                                                                                                      |
| `Boot-failure auto-revert triggered`      | post-self-modify boot crashował                | ostatni self-modify cofnięty; historia przez `memphis evolve --help`                                                                                                  |
| `path validation failed: outside sandbox` | self-modify próbował zapisać poza `~/memphis/` | by design — hasło operatora + tier-3 nie obejdzie                                                                                                                     |

### Wydajność

| Symptom                     | Diagnoza                                   | Naprawa                                                                                   |
| --------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Wolny start (>30s)          | pierwszy build na zimno                    | drugi start <5s; jeśli nie — sprawdź cache `cargo target/`                                |
| Wysokie CPU na idle         | pętla rebuild embeddings                   | wymuś jednorazowy rebuild (patrz `memphis search --help`) potem `memphis service restart` |
| Wzrost pamięci po godzinach | znane: leak vitest test harness (nie prod) | n/d w produkcji                                                                           |
| Wolna odpowiedź chat        | provider nie-streaming                     | użyj streaming providera (Ollama, Anthropic)                                              |

---

## Lokalizacje logów

| Log                  | Ścieżka                                                                   | Format             |
| -------------------- | ------------------------------------------------------------------------- | ------------------ |
| Daemon stdout/stderr | `journalctl --user -u memphis` (systemd) lub `~/.memphis/logs/daemon.log` | pino JSON          |
| Security audit       | `~/.memphis/data/security-audit.jsonl`                                    | JSONL, append-only |
| Chain blocks         | `~/.memphis/chains/<nazwa>/<indeks>.json`                                 | JSON, append-only  |
| Boot failures        | `~/.memphis/state/boot-failures.json`                                     | JSON state         |
| Vault state          | `~/.memphis/vault/vault-state.json`                                       | encrypted JSON     |
| Vault entries        | `~/.memphis/vault/vault-entries.json`                                     | encrypted JSON     |
| TUI state            | `~/.config/memphis/tui-state.json`                                        | JSON               |

Live follow: `journalctl --user -u memphis -f` (Linux) lub `tail -F ~/.memphis/logs/daemon.log`.

---

## Diagnostic dumps

Do issue załącz (niektóre komendy mogą wymagać drobnych korekt subcommand
— weryfikuj `memphis <command> --help`):

```bash
memphis health --json > memphis-health.json
memphis doctor --json > memphis-doctor.json
memphis service logs -n 500 > memphis-logs.txt
memphis providers list --json > memphis-providers.json
memphis --version > memphis-version.txt
# Plus dumps chain / audit przez `memphis chain --help` i `memphis audit --help`
```

**Zanim wyślesz publicznie — sanityzacja:**

- Usuń API keys (`grep -E 'sk-|api_key|token|password'`)
- Usuń zawartość vault entries (zaszyfrowane, ale metadata może wyciec)
- Usuń identyfikatory osobiste z chain blocks

---

## Zgłoszenie issue

1. Uruchom diagnostic dumps powyżej
2. Otwórz: https://github.com/Memphis-Chains/memphis/issues/new
3. Załącz:
   - Wersja Memphis (`memphis --version`)
   - OS + kernel (`uname -a`)
   - Wersja Node (`node -v`)
   - Wersja Rust (`rustc --version`)
   - Kroki reprodukcji
   - Sanitized log excerpt wokół błędu
   - Sanitized health/doctor JSON

---

## Gdy nic nie pomaga — czysta reinstalacja

Ostatnia deska ratunku (traci wszystkie łańcuchy i sejf):

```bash
memphis service stop
rm -rf ~/.memphis ~/.config/memphis
memphis init    # świeży stan
```

Aby zachować łańcuchy do archiwum przed wyczyszczeniem:

```bash
cp -r ~/.memphis/chains ~/memphis-chains-backup-$(date -Idate)
```

---

## Powiązane dokumenty

- **Instalacja:** [`install.pl.md`](./install.pl.md)
- **Referencja CLI:** [`CLI-REFERENCE.md`](./CLI-REFERENCE.md)
- **Disaster recovery:** [`disaster-recovery.md`](./disaster-recovery.md)
- **Runbook tier-3:** [`tier3-runbook.md`](./tier3-runbook.md)
- **Architektura (deweloperzy):** [`../dev/CANONICAL-ARCHITECTURE.md`](../dev/CANONICAL-ARCHITECTURE.md)

---

_Ostatnia weryfikacja: 2026-04-19 względem zachowania runtime'u Memphis v1.3.0 + dispatchera `src/infra/cli/registry.ts`. Top-level komendy potwierdzone (w registry v1.3.0): `health`, `doctor`, `service`, `tui`, `chat`, `ask`, `vault`, `chain`, `search`, `embed`, `evolve`, `providers`, `repair`, `init`, `mcp`, `telegram`, `trust`, `audit`, `worker`, `secret`, `schedule`, `kill-zombies`, `backup`, `self-update`, `restart`, `setup`, `configure`, `deploy`, `operator`. Składnia subcommand'ów może ewoluować — weryfikuj `memphis <command> --help`._
