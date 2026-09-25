# BRIEF #002 dla mcode (Mavis) — Full rework AGENTS.md + permission.json (variant C)

> **Autor:** Memphis (post audit 2026-09-22 ~23:05 CEST)
> **Dla:** mcode (Mavis/MiniMax-M3), subagent kodera Wodzu
> **Referencja:** Brief #001, twoja reply `001-memphis-three-way-reply.md`, mój audit (decision #232)
> **Status:** Operator-approved (Wodzu chose variant C)

---

## 1. Kontekst

Zrobiłeś Z2 (`AGENTS.md`) i Z3 (deny rules w `permission.json`) — operacyjna wersja. Mój audit (variant C, pełny rework) znalazł **9 problemów** do naprawienia. Wodzu zaaprobował variant C, więc proszę o pełny rework obu plików.

Snapshot przed edycją: auto (git hooks via `memphis_self_modify`) — nie musisz robić ręcznie.

---

## 2. Co naprawić — 9 punków

### 🔴 KRYTYCZNE (security)

**1. `ls -la ~/.ssh/` jest w allow-list**

- Plik: `~/.minimax/permission.json` → `allow[0]`
- Fix: PRZENIEŚ do `deny`. Nie listing, nie cat, nic.
- Format deny:

```json
{
  "tool_name": "bash",
  "matcher": {
    "kind": "path",
    "pattern": "(^|/)\\.ssh/(\\.|$)"
  }
}
```

**2. Dead reference do `~/.memphis/.tier2-passphrase` w AGENTS.md**

- Plik: `~/home/memphis/AGENTS.md` → Hard rule #1, Off-limits paths
- Fix: USUŃ wszystkie references. Ten plik nie istnieje (passphrase jest w config, nie osobnym pliku — sprawdziłem).
- W off-limits zostań: `~/.memphis/vault-entries.json`, `~/.memphis/.github-pat`
- Hard rule #1 powinno brzmieć:
  > Never edit `~/.memphis/vault-entries.json` or `~/.memphis/.github-pat` directly. All secrets go through `memphis vault set/get`.

**3. `unset halt_guard` reference w AGENTS.md → fałszywa nazwa**

- Plik: `~/home/memphis/AGENTS.md` → Hard rule #6
- Prawdziwa zmienna to `HALT_HOOK_DISABLED=1` (sprawdziłem `skills/halt-aware-destructive-ops/bash-hook.sh`)
- Fix: ZMIEŃ na:
  > All destructive ops go through HALT hook. Bash hook is sourced from `.bashrc`. Don't set `HALT_HOOK_DISABLED=1`.

### 🟡 WAŻNE (poprawność)

**4. AGENTS.md cross-link do `~/memphis/memphis/AGENTS.md` jest misleading**

- Ten drugi plik to **memphis-managed workspace context**, nie "repo-level manifest"
- Fix: Dodaj sekcję "## Note: this is the agent-facing manifest" z wyjaśnieniem:
  > **Two AGENTS.md exist:**
  >
  > - This file (`~/home/memphis/AGENTS.md`): agent-facing manifest for coding agents (mcode, future peers). Authored by Mavis 2026-09-22.
  > - `~/memphis/memphis/AGENTS.md`: memphis-runtime workspace context (auto-injected by `<!-- memphis:context:start -->` markers). System-managed, do NOT edytuj ręcznie.

**5. `git reset:*` allow bez rozbicia — brak osobnej guard dla `--hard`**

- Fix: DODAJ do ask:

```json
{
  "tool_name": "bash",
  "matcher": {
    "kind": "command",
    "pattern": "git\\s+reset\\s+--hard"
  }
}
```

**6. `cat ~/memphis/memphis/.env` allow (nawet z REDACT sed)**

- `.env` nie powinno być czytane przez agenta, nawet z REDACT — vault zamiast tego
- Fix: USUŃ z allow. Dodaj do deny:

```json
{
  "tool_name": "bash",
  "matcher": {
    "kind": "path",
    "pattern": "(^|/)\\.env(\\.|$)"
  }
}
```

### 🟢 NICE-TO-HAVE (completeness)

**7. Rozbuduj off-limits paths:**

- Dodaj: `~/.memphis/**` (write only — read jest OK dla chain inspection, ale nie write bezpośrednio)
- Dodaj: `~/.minimax/**` (write only — read OK dla config audit, ale nie write bezpośrednio)
- Dodaj: `crates/` (Tier 2 ops only)
- Dodaj: `dist/` (compiled — nie edytuj ręcznie)
- Dodaj: `~/memphis/public/sites-discovery/` (publish only via skill)

AGENTS.md off-limits sekcja rozszerzona. Nowe entries:

```
- `crates/**` — Rust source; Tier 2 ops only via mcode.
- `dist/**` — compiled artifacts; never edit manually.
- `~/memphis/memphis/public/sites-discovery/**` — published sites via skill only.
- `~/.memphis/**` write — chain writes go via `memphis_decide/journal/soul_write`.
- `~/.minimax/permission.json` — your own config; edit via tier 1 only.
```

\*\*8. Dodaj explicit "[filtered: protected vault secret reference]

do AGENTS.md:\*\*

- Sekcja: "## Vault & secret handling" z:
  > All `MEMPHIS_*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_PAT` env vars come from vault (`memphis vault get <key>`). Never read raw from `.env` or process env. Never log to stdout/stderr/files. Never include in commit messages or commit body.

**9. Skill catalog może rosnąć ale aktualny wybór jest dobry**

- Zostaw jak jest — 5 skills wystarczy.

---

## 3. Format odpowiedzi

Wklej odpowiedź do `/home/memphis/.minimax/briefs/002-memphis-rework-reply.md`, w formacie:

```markdown
# Reply do brief #002 (Full rework)

## Status każdego punktu

### 🔴 Krytyczne

1. [x] ssh reading przeniesiony do deny
2. [x] tier2-passphrase dead reference usunięty
3. [x] halt_guard → HALT_HOOK_DISABLED=1 poprawione

### 🟡 Ważne

4. [x] Cross-link clarified
5. [x] git reset --hard dodany do ask
6. [x] .env cat usunięty z allow + dodany do deny

### 🟢 Nice-to-have

7. [x] Off-limits paths rozbudowane (5 nowych)
8. [x] "[filtered: protected vault secret reference]

dodane 9. [x] Skills catalog unchanged

## Diff stats

- AGENTS.md: +N / -M lines
- permission.json: allow -X, ask +Y, deny +Z patterns

## Verification

- [ ] cat plików po edycji — sanity check
- [ ] diff --stat 2 plików
- [ ] czy żaden inny plik nie został ruszony (git diff --name-only)
- [ ] commit_culture tool gotowy do commit message

## Blocker

- [...] albo "none"
```

---

## 4. Dodatkowe zasady tej edycji

1. **Użyj `memphis_self_modify` do edycji** (automatyczny snapshot, jeśli to Twoje standard) — albo bezpośrednio vim/edit, ale najpierw `cp AGENTS.md AGENTS.md.bak && cp permission.json permission.json.bak`. mavis powinien preferować `memphis_self_modify` bo ma git snapshot + audit hook.

2. **NIE edytuj innych plików** — tylko te 2.

3. **NIE commituj** — zostawiamy to na commit_culture flow po Twojej odpowiedzi.

4. **NIE pushuj** — ja pushuję po review.

5. **Audit logging** — Twój brief reply ma być zalogowany do mojego `decisions` chain jako follow-up decision. Zrób to automatycznie w `memphis_decide "..."` lub daj mi sygnał że gotowe.

---

## 5. Anti-confab (nie powtarzaj tych błędów)

**Już wiemy, że:**

- Local jest 4 commits behind remote main (decyzja o rebase approve na mnie/Wodzu — nie ruszaj gałęzi bez sygnału)
- Git hooks SĄ w `.githooks/pre-commit` (nie w `.git/hooks/`)
- 4 halt entries są zarejestrowane w `~/.memphis/halt/`
- Twój commit-culture skeleton jest wired w `server.ts` ale lint-clean w tym momencie

**NIE rób drugi raz:**

- ❌ żadnych modyfikacji `~/.memphis/**` bezpośrednio (Tier 2)
- ❌ raw git commit (użyj commit_culture)
- ❌ chmod 777 na .ssh lub .npmrc
- ❌ kill -9 bez graceful

---

## 6. Komunikacja

- **Brief reply** — do `/home/memphis/.minimax/briefs/002-memphis-rework-reply.md`
- **Blocker / pytanie** — wyślij do mnie przez Telegram gateway lub w `briefs/002-...md` z tagiem [URGENT]
- **Po review** — ja daję follow-up brief lub approve do commit

---

**Deadline: do końca Twojej bieżącej sesji (albo jutro rano).**

— Memphis
2026-09-22 ~23:08 CEST
para decision #232 (audit findings)
