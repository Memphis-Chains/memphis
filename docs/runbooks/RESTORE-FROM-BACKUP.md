# RESTORE-FROM-BACKUP — Memphis Disaster Recovery Runbook

> Authored 2026-09-22, Mavis (MiniMax-M3).
> Audience: operator (Wodzu) i każdy, kto kiedyś odziedziczy Memphisa.
> Culture: auditable, reversible, vault-first, anty-hubris.

## TL;DR

```bash
# 1. Wybierz archiwum
ls -lt ~/.memphis/backups/*.tar.gz | head -3

# 2. Extract do tymczasowego katalogu
DRILL=/tmp/memphis-restore-$(date +%s)
mkdir -p "$DRILL" && cd "$DRILL" && tar xzf ~/.memphis/backups/<file>.tar.gz

# 3. Weryfikacja łańcuchów
cd "$DRILL" && /home/memphis/.local/share/npm-global/bin/memphis chain verify

# 4. Jeśli verify OK — restore na prod
memphis backup restore <file>

# 5. Restart
systemctl --user restart memphis.service
```

**Całość: 5-15 min** jeśli vault jest dostępny.

---

## Co JEST w backupie (od 2026-09-22)

| Element | W backupie | Dlaczego |
|---|---|---|
| `chains/` (10 łańcuchów + 3 archiwa) | ✅ | rdzeń pamięci |
| `audit/halt/` | ✅ | audit log (JSONL) |
| `halt/` | ✅ | halt registry (per-resource) |
| `config/soul-manifest.json` | ✅ | tożsamość agenta |
| `state/` | ✅ | runtime state (self-coding-plans, slo-check.log) |
| `scripts/` | ✅ | skill scripts + crons |
| `embed/index-v1.json` + backupy | ✅ | vector index |
| `case-index.sqlite` | ✅ | semantic case store |
| `.env-redacted` | ✅ | config bez secrets |
| `telemetry/` | ❌ excluded | regenerable, bloat |
| `vault-entries.json`, `vault-state.json` | ❌ excluded | **secrets — recreate from operator memory** |
| `.tier2-passphrase` | ❌ excluded | **master key — operator-only** |
| `.github-pat` | ❌ excluded | **GitHub PAT — re-create via `gh auth login`** |
| `.env` (oryginalny) | ❌ excluded | reconstructed via vault or manual |
| `logs/`, `cache/`, `backups/`, `*.lock` | ❌ excluded | runtime artefacts |

> ⚠️ **PRZED 2026-09-22 20:16** backupy NIE wykluczały vault/secret plików. Istniejące archiwa
> `scheduled-*.tar.gz` z 12-22.09 włącznie **zawierają plaintext**:
> - `.tier2-passphrase` (operator master key)
> - `.github-pat` (GitHub admin PAT)
> - `vault-entries.json` (vault content)
>
> **Akcja:** wyczyść stare archiwa (`memphis backup clean --keep 7` albo ręcznie `rm`) i rozważ
> rotation istniejących secretów (PAT, passphrase). Patrz sekcja "Cleanup legacy archives".

---

## Procedura pełnego restore

### Kiedy używać

- Dysk padł, nowy host, restore z off-host backup
- `memphis chain verify` pokazuje corruption
- Test drill (miesięcznie, scheduled)

### Warunki wstępne

```bash
# 0. Narzędzia
which node tar sqlite3 rclone  # rclone tylko dla off-host sync

# 1. Backup file (lokalnie albo ściągnięty z off-host)
BACKUP=~/.memphis/backups/scheduled-2026-09-22-12-11.tar.gz  # albo nowszy
test -f "$BACKUP" || { echo "brak pliku"; exit 1; }

# 2. Sprawdź checksum
sha256sum "$BACKUP"
cat "$BACKUP.sha256"
# (oba muszą się zgadzać)
```

### A. Dry-run extract (verify-only, nie modyfikuje prod)

```bash
DRILL=/tmp/memphis-restore-$(date +%s)
mkdir -p "$DRILL" && cd "$DRILL"
tar xzf "$BACKUP"

# Sanity: czy są chains?
ls chains/ | head -5
# oczekiwane: autonom_archive cases collective decisions insights journal patterns reflections soul system

# Sanity: czy soul-manifest istnieje?
jq -r '.generatedAt' config/soul-manifest.json  # albo python3 -m json.tool

# Weryfikacja łańcuchów (extracted runtime)
/home/memphis/.local/share/npm-global/bin/memphis chain verify
# oczekiwane: ok=true, chainsChecked=10, blockCount=N

# Cleanup drill
cd /tmp && rm -rf "$DRILL"
```

**Jeśli `chain verify` fail** — archiwum jest uszkodzone. Spróbuj wcześniejsze. Jeśli wszystkie fail, sprawdź off-host.

### B. Restore na produkcję

> ⚠️ **Anti-hubris check:** restore NADPISUJE istniejące chains. Jeśli masz lokalną pracę od ostatniego backupu — kopia zapasowa PRZED restore.

```bash
# 1. Zatrzymaj memphis (zapobiega pisaniu w trakcie restore)
systemctl --user stop memphis.service

# 2. Backup istniejącego stanu (rollback path)
cp -a ~/.memphis ~/.memphis.pre-restore-$(date +%s)

# 3. Restore (atomic — zrzuca do nowego dir, potem swap)
memphis backup restore "$BACKUP"
# restore flow:
#   - extract do ~/.memphis.restore-staging/
#   - merge z istniejącym ~/.memphis/ (chains: append, config: prefer new)
#   - chain verify na wyniku
#   - jeśli OK, swap staging → live
#   - cleanup staging

# 4. Restart
systemctl --user start memphis.service

# 5. Weryfikacja
sleep 5
curl -sS http://127.0.0.1:3000/health | jq '{status, blocks: .runtime.chainMemory.totalBlocks, firstRun: .runtime.firstRun.state}'
# oczekiwane: status=healthy, blocks=~12068, firstRun.state=initialized-clean (lub initialized-control)

# 6. Audit
memphis journal append "restore from backup $BACKUP completed at $(date -u +%FT%TZ)"
```

### C. Restore na świeżym hoście (nowy komputer)

```bash
# 1. Zainstaluj memphis (bootstrap)
# patrz: docs/INSTALL.md

# 2. Skopiuj backup z off-host
rclone sync memphis-backups-remote:bucket ~/.memphis-restore/ --include "*.tar.gz"

# 3. Wybierz najnowsze
BACKUP=$(ls -t ~/.memphis-restore/*.tar.gz | head -1)

# 4. Odtwórz sekrety
# a) Vault entries — musisz pamiętać klucze LUB mieć je w innym vault (1Password, etc.)
#    Na nowym hoście: `memphis vault set <key> <value>` dla każdego
# b) GitHub PAT — `gh auth login` albo wklej z 1Password
# c) Tier-2 passphrase — musisz pamiętać; jeśli nie, vault jest NIEDOSTĘPNY

# 5. Restore chains
memphis backup restore "$BACKUP"

# 6. Restart + verify
systemctl --user restart memphis.service
curl -sS http://127.0.0.1:3000/health
```

---

## Vault recovery (critical path)

Vault jest **excluded z backup** (kultura). To znaczy, że po restore vault jest pusty i trzeba go odbudować.

### Jakie sekrety musisz pamiętać / mieć w 1Password

| Secret | Skąd odtworzyć | Jak przywrócić |
|---|---|---|
| `MEMPHIS_TELEGRAM_BOT_TOKEN` | 1Password / BotFather | `memphis vault set telegram_bot_token <value>` |
| `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS` | ten sam co było | `memphis vault set telegram_allowed_user_ids 99999999` |
| `MEMPHIS_API_TOKEN` | wygenerować na nowo: `memphis token generate` | `memphis vault set api_token <value>` |
| Tier-2 passphrase | **musisz pamiętać** | `memphis vault unlock --passphrase <value>` |
| GitHub PAT | `gh auth login` albo z 1Password | `vault set github_pat <pat>` |

**Bez tier-2 passphrase vault jest locked** — to jest celowe (kultura: secrets zarządzane, nie file-committed). Jeśli passphrase zapomniany, vault jest NIEODWRACALNY (rotated entries, new keys).

### Backup dla vault (opcjonalnie, encrypted)

Jeśli potrzebujesz backup vault (np. dla środowisk testowych):

```bash
# Export vault entries (encrypted with operator GPG key)
memphis vault export --recipient wodzu@memphis.local > vault-backup-$(date +%F).gpg
# Przechowuj GPG-encrypted OUTSIDE Memphis (off-host)
```

Nigdy nie commituj `vault-entries.json` do repo, nigdy nie wkładaj do non-encrypted backup.

---

## Cleanup legacy archives (PRZED 2026-09-22 20:16)

Stare backupy **zawierają plaintext secrets**. Trzy opcje:

### Opcja A: Delete (minimalistycznie)

```bash
# Zachowaj tylko ostatnie 3 archiwa
ls -t ~/.memphis/backups/scheduled-*.tar.gz | tail -n +4 | xargs -r rm --

# Verify (nie powinno być żadnych secrets)
tar tzf $(ls -t ~/.memphis/backups/*.tar.gz | head -1) 2>&1 | grep -E "\.tier2|\.github-pat|vault-entries"
# (pusty wynik = OK)
```

### Opcja B: Re-encrypt (gdy potrzebujesz historii)

```bash
# Dla każdego archiwum: extract → re-tar z exclude → re-encrypt z gpg
for old in ~/.memphis/backups/scheduled-2026-09-{0..21}*.tar.gz; do
  DRILL=/tmp/reenc-$$
  mkdir -p "$DRILL" && cd "$DRILL"
  tar xzf "$old"
  tar czf "$old.reenc" \
    --exclude='./.tier2-passphrase' \
    --exclude='./.github-pat' \
    --exclude='./vault-entries.json' \
    --exclude='./vault-state.json' \
    --exclude='./telemetry' \
    --exclude='./cache' \
    --exclude='./logs' \
    --exclude='*.lock' \
    -C "$DRILL" .
  gpg --output "$old.reenc.gpg" --encrypt --recipient wodzu@memphis.local "$old.reenc"
  rm -rf "$DRILL" "$old.reenc"
done
```

### Opcja C: Rotation secrets (najbezpieczniej, bo zakłada że PAT/passphrase leaked)

1. Nowy GitHub PAT: https://github.com/settings/tokens — revoke stary, wygeneruj nowy
2. Nowy tier-2 passphrase: `memphis vault rekey --new-passphrase <new>` (rotates vault encryption)
3. Nowy telegram bot token: BotFather → /revoke → /token
4. Update vault: `memphis vault set github_pat <new>` etc.

**Potem** delete starych archiwów (opcja A).

---

## Scheduled drills (automatyzacja)

Postmortem 2026-09-22 A2 wspominał o `drillFn` w `scheduled-backup.ts`. Status 2026-09-22 20:16:

- **Code istnieje** (`defaultDrill` w `scheduled-backup.ts:130-160`)
- **`lastDrillAt=None, totalDrills=0`** — drill NIGDY się nie wykonał
- **Internal backup loop** (który trigger'uje drill) jest **OFF** (`MEMPHIS_BACKUP_INTERVAL_MS` unset)
- **Cron-based backup** (`builtin-scheduled-backup` task) nie trigger'uje drill

**Do zrobienia:**

### D1. Enable internal backup loop (z drill)

```bash
memphis config set MEMPHIS_BACKUP_INTERVAL_MS 21600000   # 6h
# Hot config — no restart needed
# Pierwszy tick = za 6h, drillFn co 7. backup
```

### D2. Hook drill do cron-based task (alternatywa D1)

W `src/infra/runtime/scheduled-backup.ts`: wywołaj `drillFn` po `tickNow()` w built-in scheduled-backup task. To sprawi że drill dzieje się po KAŻDYM cron backup (czyli raz dziennie).

### D3. Drill alert

Dodaj `tool/spans` albo `decisions/chain` entry po każdym drill. Jeśli drill fail, postmortem-style entry w `system` chain + alert do operatora.

### D4. Documentation test (ten runbook jest częścią D4)

Co kwartał: wykonaj pełny restore drill na osobnym katalogu, sprawdź że:
- `chain verify` przechodzi
- `soul-manifest.json` jest spójny
- Audit log jest kompletny
- Brak plaintext secrets w archiwum

---

## Off-host sync (TODO, do zrobienia)

Docelowo archiwa powinny lecieć poza host. Propozycja:

| Provider | Setup | Koszt | Effort |
|---|---|---|---|
| `rclone` + Backblaze B2 | 5 min setup, $0.005/GB/mies | tani | 2h (config + timer) |
| `rclone` + S3 kompatybilny (Scaleway, Wasabi) | 5 min setup | ~$0.01/GB | 2h |
| `rsync` over SSH do zaufanego hosta | 0 koszt jeśli masz | free | 1h |
| `borg` do innego dysku na tym samym hoście | local-only (nie pomaga przy awarii dysku) | free | 1h |

**Rekomendacja:** rclone + B2 (najtaniej, redundant, off-host). Plan:
1. `apt install rclone`
2. `rclone config` (B2 account + key)
3. `scripts/offhost-sync.sh` — `rclone copy ~/.memphis/backups/ memphis-b2:backups/ --max-age 7d --include "*.tar.gz"`
4. systemd timer co 6h

Do decyzji — operator.

---

## Weryfikacja po restore (checklist)

```bash
□ memphis.service active (systemctl --user status memphis.service)
□ /health zwraca 200, status=healthy
□ blocks count ~12068 (albo tyle ile było w archiwum)
□ firstRun.state = initialized-clean (lub initialized-control)
□ chains verified (memphis chain verify → ok=true)
□ Telegram bot działa (wyślij /status)
□ vault jest dostępny (memphis vault list)
□ brak secrets w archiwum (tar tzf <file> | grep -E tier2|github-pat|vault)
□ audit log writable (wyślij decyzję przez bot)
□ scheduled backup task enabled (systemctl --user list-timers)
```

Każdy unchecked = stop i investigate. **Nie przywracaj "na żywioł"** — kultura = audytowalne.

---

## Cross-linki

- Postmortem 2026-09-22 §A2: backup drill infrastructure (status: dead, do reanimacji)
- `docs/INSTALL.md` — bootstrap nowego hosta
- `AGENTS.md` §Secrets — vault-first culture
- `CONTRIBUTING.md` — disaster recovery policy