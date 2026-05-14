# Handoff do Codera A — review queue 2026-05-12 wieczór (REV 5 — FULL AUTOMODE)

**From:** Coder B
**To:** Coder A
**Operator (Wodzu):** Marcin
**Mantra tej sesji:** **"robimy żeby działało"** — priorytet = co operator widzi naprawione w codziennym użyciu, nie estetyka.

**Workflow (REV 4 — FULL AUTONOMY, bez pingu operatora):**

- **Mergeujesz SAM** po CI green. Operator NIE klika merge.
- **Daemon restart SAM** po merge (`systemctl --user restart memphis`).
- **Następny temat startujesz NATYCHMIAST** — bez czekania, bez pingu operatora.
- **Zero parallel branches** — jeden otwarty PR na raz.
- **Zero scope creep** — nowy bug poza scope = ZAPISZ w `notes/discovered-<date>.md` i jedź dalej z bieżącym tematem.
- **Pre-commit hook green PRZED push.** `--no-verify` zakazany.
- **Lokalny full test run (`npm test`) PRZED push.** CI = safety net, nie wykrywacz.
- **Codex review monitoring:** po KAŻDYM merge sprawdzasz `gh pr view <N> --comments` przez kolejne 24h (Codex reaguje 1-3h post-merge zwykle). Findings → bundled `hotfix/codex-round-N` po wszystkich tematach (per `feedback_codex_bundled_hotfix.md`). Per `feedback_codex_review_judgment.md`: evaluate każde finding przeciw Memphis konwencji — jeśli Memphis ma inny pattern, push back PR comment'em, nie ślepe accept.

**Autonomous loop (REV 4 — fast lane, bez czekania):**

```
START Temat N
  ↓
implement + local tests + lint + tsc clean
  ↓
push + gh pr create + gh pr merge --auto --squash   ← auto-merge sam się odpali jak CI green
  ↓
START Temat N+1 NATYCHMIAST              ← nie czekaj na merge confirmation
  ↓
[w między czasie poprzedni PR auto-mergeuje gdy CI green]
  ↓
przed startem Temat N+2: git pull + restart jeśli code-affecting (skip restart dla notes/docs/tests-only PR)
  ↓
[repeat T0→T1→T2→T3.5→T4→T5]
  ↓
po T5: gh pr list --state merged --search "from:me" + zerknij Codex comments NA WSZYSTKICH naraz
  ↓
open hotfix/codex-round-N z bundled findings → push + --auto --squash → DONE
  ↓
final ping do operatora: "queue done"
```

**Konkretne zasady:**

- **`--auto` flag**: `gh pr merge --auto --squash` rezerwuje merge, GitHub sam zmerguje gdy CI green. Nie polluj się polling.
- **Następny temat startujesz natychmiast** po `gh pr merge --auto`. Nie czekaj na sukces merge.
- **Restart daemona TYLKO gdy code-affecting** (dist/ rebuilt). Notes/docs/tests-only PR-y NIE wymagają restart.
- **Codex check po wszystkich tematach** (nie 24h po każdym). Jeden batched check po T5 → jeden bundled hotfix PR.
- **Jeśli auto-merge fail** (CI red): popraw fix-on-top, push, kolejny `gh pr merge --auto`. Nie blokuje następnego tematu (independent branch).
- **Conflict na poprzednim PR** (rebase needed): obsłuż dopiero gdy GitHub powie "blocked". Nie pre-empt.

**Jedyne pingowanie operatora:**

1. Final: "queue done, T0→T5 + codex round merged"
2. Hard blocker: 3 attempts failed, nie umiesz sam rozwiązać → opisz dokładnie co próbowałeś i co zwróciło. Wtedy operator wraca.
3. Discovered issue poza scope: zapisz w `notes/discovered-<date>.md`, ping NA KONCU sesji jednym dump'em (nie per-issue).

---

## 0. Anti-isolation — przed otwarciem KAŻDEGO brancha

1. `git fetch --all --prune`
2. `gh pr list --state open` — sprawdź czy żaden inny PR nie tyka Twojego pliku
3. **Mój scope (Coder B — NIE TYKAJ):**
   - `src/modules/nightly/*`
   - `src/kartograf/rollback.ts`
   - `src/infra/runtime/atomic-write.ts`
   - `tools/training/kartograf_train/status_writer.py`
   - `notes/kartograf-training-run-*.md`, `notes/segv-rca-*.md`, `notes/pr*-pre-merge-review.md`
   - Untracked w worktree do mnie należą.
4. **Twój scope (full ownership):**
   - `src/gateway/*` (poza `channels/telegram.ts` w sekcji `/nightly` subcommand — jeśli kiedyś dodam)
   - `src/mcp/*`
   - `src/modules/self-coding/*`
   - `src/infra/observability/*`
   - `src/infra/logging/*`
   - `src/security/*`
   - `crates/memphis-tui/*` (S3 SEGV)
   - `src/app/bootstrap.ts:527-551` stopFns (oboje appendujemy, NIE modyfikujemy istniejących entries)
   - `tools/training/train-kartograf.py` + `kartograf_train/train.py` (cały Python trainer wrapper)
5. **Jeśli widzisz mój branch z podobnym tematem** — PR comment FIRST, nie parallel.

---

## 1. STAN OBECNY (post-merge 2026-05-12 22:49)

| PR | Status |
|---|---|
| #592 soul-seed dead-tools | **MERGED** ✅ |
| #593 S5 self-coding loop + B1 fix | **MERGED** ✅ |
| #594 S1+S2 operator decisions | **MERGED** ✅ |
| **#595 audit-write VITEST guard (block 1853)** | **MERGED** ✅ 21:24:53Z (commit `3263eb99` na main). 3 fix commits: `231ad931` + `1322d39b` + `3bebca3a`. |
| Daemon | Active, **NIE restartowany** po merge — operator zrobi po #595 merge |
| SEGV embed_shutdown | RCA w `notes/segv-rca-2026-05-12.md` — fix shape jak PR #588 mirror |
| Kartograf training run | Smoke run BLOCKED — `transformers<4.48`, ModernBERT not recognized. F1-F10 findings w `notes/kartograf-training-run-2026-05-12.md` |
| Telegram photo describe | **NIE DZIAŁA** — `memphis_exec` restricted mimo tier-3 active, photo path nie exposable agentowi |
| Codex round-N #593+#594 | Pending post-merge run |

---

## 2. QUEUE — REVISED PRIORITY (according to "robimy żeby działało")

Kolejność = **co operator widzi DAILY-broken vs RZADKO-broken vs RAZ-broken**. Niżej = ważniejsze do polish, ale wyżej = pilniej żeby działało.

### ✅ TEMAT 0: #595 audit-write VITEST guard — **DONE, MERGED**

**Status:** PR #595 open, **CI failed ×2** mimo helper-level fix (`1322d39b`). Pierwszy fix załatwił `tests/ops/` ale wyszły 2 nowe:

```
tests/security/audit-coverage.test.ts:109
  Error: ENOENT: no such file or directory, open '/tmp/memphis-audit-log-.../security-audit.jsonl'

tests/integration/bootstrap-queue-resume-audit.e2e.test.ts
  writes queue.resume.startup audit details with safe-mode redispatch override
```

Oba testy **JUŻ mają** `MEMPHIS_TEST_ALLOW_AUDIT_WRITE='1'` w `beforeEach`. To **NIE jest missing-env**, to jest **test ordering bug**:

```typescript
// tests/security/audit-coverage.test.ts:34-53
beforeEach: process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE = '1';   // ✅ set
it(): {
  line 40:  process.env.MEMPHIS_TEST_ALLOW_AUDIT_WRITE = '1';    // ✅ ok
  line 41:  const config = makeConfig();
  line 42:  const container = createAppContainer(config);        // ⚠️ container snapshots env?
  line 43:  const app = createHttpServer(config, container.orchestration, ...);
  line 52:  process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = auditPath;   // ⚠️ set AFTER container
  line 54+: app.inject(...) → handler → writeSecurityAudit(event, ???rawEnv???)
  line 109: readFileSync(auditPath) → ENOENT
}
```

Hipotezy do zweryfikowania (po kolei, prawdopodobieństwo):

1. **rawEnv snapshot w container/HTTP handler** — gdzieś w container/HTTP server jest `{ ...rawEnv }` spread przy konstrukcji (line 42) zanim test ustawi `MEMPHIS_SECURITY_AUDIT_LOG_PATH` (line 52). Audit-write resolveAuditLogPath() używa STAREGO snapshotu = default `~/.memphis/security-audit.jsonl`, nie /tmp. Plik /tmp nigdy nie powstaje → ENOENT.
2. **Guard refuses cichaczem** — `emitAuditWriteGuardWarning` early-returns, audit nie zapisany. Wymaga `console.error/stderr` trace w wycinku CI logu na "audit-guard skipped" — sprawdzić.
3. **Vitest poolSize > 1** — testy w paraleli, inny test deletes `MEMPHIS_TEST_ALLOW_AUDIT_WRITE` w afterEach przed tym testem skończy.

**Optymalny fix path:**

1. **First**: dodaj `console.error` log w `emitAuditWriteGuardWarning` żeby zobaczyć w CI logach czy guard fires (hipoteza 2).
2. Jeśli **YES** guard fires: znajdź w HTTP route handler chain miejsce gdzie rawEnv jest spread'owany; refactor żeby PASS `process.env` (live ref) zamiast snapshot.
3. Jeśli **NO** guard fires: hipoteza 1 — przenieś `MEMPHIS_SECURITY_AUDIT_LOG_PATH` set BEFORE `createAppContainer()` w testach (przed line 42, nie po). Małe 2-linijkowe move per test file.
4. Run testy lokalnie najpierw (`npm test -- audit-coverage bootstrap-queue-resume`) **before push**. Pre-commit hook should have caught to.

**ETA:** 1-2h. Plus pre-commit hook check.

---

### 🔴 TEMAT 1 (P0 DEMO BLOCKER): memphis_exec tier-3 bypass + Telegram photo path

**Co operator widzi gdy fixed:**
- Wysyła zdjęcie na Telegram → bot opisuje co widzi (vision pipeline działa)
- `/tier 3 <pass>` → agent może rzeczywiście używać exec bez "shell metacharacters" blocku
- `memphis_glob` widzi telegram attachmenty

**Co operator widzi teraz (broken):**
- Bot: *"nie mam ścieżki do pliku, exec zablokowany, Telegram nie zapisuje lokalnie"* (kłamie — telegram.ts:931 ZAPISUJE do /tmp ale potem unlink'uje)
- `/tier 3` pokazuje active, ale exec dalej dostaje "shell metacharacters blocked"

**Source:** Operator Telegram session 22:31-22:46 2026-05-12 (logi w handoffie były wcześniej).

**Root cause hypothesis (do potwierdzenia):**

**Bug 1: exec tier-3 bypass nie działa.**
- `src/gateway/exec-policy.ts:274-275`: `restrictedMode = isFullAutonomy ? false : ...` — czytane z `rawEnv.MEMPHIS_AUTONOMY_MODE`
- `src/security/tier3-session.ts:495-508` `buildTier3EnvOverride` zwraca `MEMPHIS_AUTONOMY_MODE: 'full'`
- `src/gateway/channels/telegram.ts:106-108` plumbs override jako `rawEnvOverride` w `handler()` call

Jedna z tych ścieżek się nie domyka. Trace plumbing od telegram.ts:107 przez turn-runtime do `runMemphisExec` call site (`src/mcp/tools/exec.ts:37`).

**Bug 2: Telegram photo path nie jest exposable agentowi.**
- `src/gateway/channels/telegram.ts:931-936` zapisuje photo do `os.tmpdir()` = `/tmp/tg-photo-{msg_id}-{ts}.{ext}`
- `src/gateway/channels/telegram.ts:947-950` (finally) **unlink'uje tempPath** po `ingestMedia`
- Agent w następnym turn'ie nie ma dostępu (już skasowany) ani path-a (nigdzie nie zapisany)

**Fix shape:**

```typescript
// src/gateway/channels/telegram.ts — replace tempPath /tmp pattern:
const persistDir = join(getDataDir(process.env), 'state', 'telegram-attachments');
mkdirSync(persistDir, { recursive: true, mode: 0o700 });
const persistPath = join(persistDir, `tg-photo-${msg.message_id}-${Date.now()}${ext}`);
await fs.writeFile(persistPath, photoBuffer);
// ingestMedia(persistPath, ...) — keep file after ingest, NIE unlink
// THEN system prompt fragment for THIS turn:
systemPromptAppend = `<latest_attachment kind="image" path="${persistPath}">\n${visionDescription || '(no description available — call memphis_media_ingest with the path to retry)'}\n</latest_attachment>`;
```

Plus:
- `src/mcp/tools/fs-permission.ts` (lub gdzie path-allowlist dla `memphis_glob` / `memphis_code_read`) — dodaj `~/.memphis/state/telegram-attachments/**`
- Doctor check `ta18-telegram-attachments-storage`: dir exists + warn jeśli mtime newest > 7d (cron-prune candidate)
- Cron job (or runtime hook) to prune attachments older than 7d

**Plus dla Bug 1 — add debug log:**
```typescript
// src/gateway/exec-policy.ts:loadGatewayExecPolicy entry
log.debug({
  restrictedMode,
  autonomyMode: rawEnv.MEMPHIS_AUTONOMY_MODE,
  surface_max_tier: rawEnv.MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER,
}, 'exec policy resolved');
```

Potem operator + Ty czytamy log na żywej sesji, widzimy gdzie rawEnv się rozłącza.

**PR shape:**
- Branch: `fix/telegram-vision-and-exec-tier3-trace`
- Files: `src/gateway/channels/telegram.ts` (path persist + system prompt fragment), `src/gateway/exec-policy.ts` (debug log), `src/mcp/tools/fs-permission.ts` lub odpowiednik (glob allowlist), `src/infra/cli/utils/doctor-v2.ts` (ta18 check), retention cron.
- Tests:
  - Telegram handler test: photo handler writes to `~/.memphis/state/telegram-attachments/`, NOT /tmp; system prompt fragment ma `path` attribute
  - fs-permission glob over `~/.memphis/state/telegram-attachments/*` returns matches
  - exec-policy: w isolation, gdy `MEMPHIS_AUTONOMY_MODE=full` → `restrictedMode=false`
  - Doctor ta18: dir missing → warn z fix command

**ETA:** 3-4h. Może być 6h jeśli trace plumbing wymaga deep debug.

**Verification (B-step po merge + restart):**
1. Operator wysyła zdjęcie na Telegram bot
2. Bot opisuje co widzi (Ollama vision pipeline)
3. Operator: `/tier 3 <pass>` then "uruchom find -name 'tg-photo-*' /home/memphis"
4. Agent: exec passes, lists files
5. Operator widzi że attachment dalej jest na dysku w persistent location

---

### 🔴 TEMAT 2 (P1 — daemon stability): SEGV embed_shutdown race

**Co operator widzi gdy fixed:**
- `systemctl --user restart memphis` zawsze czysty exit (no core dump)
- `kill -TERM <pid>` clean shutdown nawet podczas embed batch

**Co operator widzi teraz:**
- Sporadyczne SEGV-y (1 zachowany core dump 2026-05-12 15:47, Coder A status report wspomina że #588 fix zamknął recurring pattern ale RCA z core dump pokazuje że to inny binding — `embed_shutdown`, nie `memphis_exec`)

**Source:** `notes/segv-rca-2026-05-12.md` (moja RCA — pełny stack trace zachowany)

**Stack trace (crashed thread):**
```
#0  0x0000000000000000        ← NULL pointer call (rip=0x0)
#1  AtomicU32::load
#2  Once::is_completed
#3  OnceLock<Mutex<EmbedPipeline>>::initialized
#5  OnceLock::get → self=<memphis_napi::EMBED_PIPELINE>
#6  memphis_napi::embed_shutdown          crates/memphis-napi/src/lib.rs:596
#7  memphis_napi::embed_shutdown_c_callback crates/memphis-napi/src/lib.rs:594
#8  v8impl::FunctionCallbackWrapper::Invoke
```

**Action items (z RCA):**

1. **A1**: Sprawdź ordering stopFns w `bootstrap.ts:527-551` — czy `embed-shutdown` jest tam jako Memphis-managed stopFn, czy registered jako `napi_add_env_cleanup_hook` (V8-managed, fires PO Memphis stopFns drain — exactly the race).
2. **A2**: Audit `crates/memphis-napi/src/lib.rs:594-596` — callback shape:
   - Czy używa `OnceLock::get` (safe, Option<&T>) vs `unwrap_unchecked` (UB on stale state)?
   - Czy `embed_pipeline` drain jest idempotent + safe po V8 GC?
3. **A3**: Jeśli currently registered via `napi_add_env_cleanup_hook` → migracja do explicit Memphis stopFn (mirror PR #588 dla Kartograf).
4. **A4**: Verify fix: kill -TERM podczas heavy embed activity (`memphis health` loop emitting writes). Pre-fix: SEGV with this stack. Post-fix: clean exit.

**PR shape:**
- Branch: `fix/embed-shutdown-race`
- Files: `crates/memphis-napi/src/lib.rs` (callback safety), `src/app/bootstrap.ts:527-551` (APPEND `embed-pipeline` stopFn entry obok kartograf-onnx-session — NIE modyfikuj istniejących), `src/infra/storage/rust-embed-adapter.ts` (TS-side wrapper jeśli potrzebny).
- **Rust rebuild required:** `npm run build:rust` przed B-stepem (per `feedback_napi_rebuild_after_rust_changes`).
- Tests: shutdown sequence test mocking V8 teardown.

**ETA:** 3-4h.

---

### ~~TEMAT 3~~ — **DELETED** (this was Block 1853 fix; same as T0 above, merged via #595)

### 🟡 TEMAT 3 PLACEHOLDER (skipped intentionally, do not reuse number)

**Co operator widzi gdy fixed:**
- `memphis doctor` przestaje flagować corruption na block 1853
- Self-modify / self-plan / future tests nie dodają więcej corruption do chain

**Co operator widzi teraz:**
- `memphis doctor` żółty warning na chain integrity (jeden zerwany link 1852→1853)
- Każdy next test run S5 self-modify może dodać kolejną corruption

**Source:** `notes/system-chain-corruption-2026-05-12.md` (Twoja).

**Operator decyzja:** Opcja **A** (accept + fork-marker) + engineering guard.

**Co zrobić:**
1. Mark block 1853 jako fork-marker w chain metadata — integrity scan respektuje marker i nie flaguje.
2. Engineering guard w `emitRuntimeSecurityEvent` (i każdym innym audit-write path): refuse-write w VITEST envie chyba że `MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1` explicit set.

**PR shape:**
- Branch: `fix/audit-write-vitest-guard`
- Files: `src/infra/logging/security-audit.ts` (guard), tests które legitnie potrzebują pisać audit set env w `beforeEach`, `notes/system-chain-corruption-2026-05-12.md` (post-mortem update).
- Tests: regression — self-modify + self-plan testy without env → audit NIE pisane; z env → pisane.

**ETA:** 1-2h.

---

### 🔴 TEMAT 3.5 (P1 NEW — operator vision): Memphis agent operator-mode wisdom (exec wisely)

**Source:** Operator 2026-05-12 wieczór — *"Memphis ma mieć możliwość w wyjątkowych sytuacjach, kiedy jego tools i skills nie starczają, na użycie DOWOLNYCH komend. Memphis ma wiedzieć co może a czego nie za pomocą tych komend, używać ich mądrze, próbować przewidzieć co się stanie jak je uruchomi po wcześniejszej analizie. Make it legit!"*

**Co operator widzi gdy fixed:**
- Memphis Agent przy tier-3 active może w razie potrzeby uruchomić DOWOLNĄ komendę (`rm -rf /tmp/junk`, `find ~/ -name "*.log"`, `apt-get install ...`)
- ALE robi to **mądrze** — analizuje co command zrobi PRZED uruchomieniem, ostrzega operatora przy irreversible, dry-runuje gdy może, audytuje każdy exec
- Operator w audit log widzi: "agent miał intent X, przeanalizował command jako Y (impact: Z), uruchomił, exit code N, output snapshot"
- Agent rozumie różnicę: `git status` (safe, idempotent) vs `rm -rf` (destructive) vs `apt install vim` (system-wide, reversible via apt remove) vs `dd if=/dev/zero of=/dev/sda` (irreversible, refuse without explicit override)

**Co operator widzi teraz (broken):**
- Tier-3 exec bypass nie działa (T1 fix)
- Nawet z tier-3, agent nie ma "wisdom layer" — exec'uje blind, nie analizuje, nie pyta
- Audit log zapisuje "uruchomił command X" ale BEZ kontekstu intent/predicted-impact/reversibility

**Architektura — pięć warstw:**

#### Warstwa 1: tier-3 unrestricted works (T1 zależność)

Done przy T1. `MEMPHIS_AUTONOMY_MODE=full` flips `restrictedMode=false` w `src/gateway/exec-policy.ts:274` → no allowlist, no shell-metachar block, full pass-through.

#### Warstwa 2: pre-exec analysis tool

**Nowy tool:** `memphis_exec_analyze` (tier 1 read — bezpieczne, czysta inspekcja).

Input: `{ command: string, surface_intent?: string }`

Output:
```typescript
{
  parsed: { base: string, args: string[] };
  semantic: string;              // "lists files in /etc"
  side_effects: 'read-only' | 'local-write' | 'system-state' | 'network' | 'irreversible';
  files_touched: string[];       // best-effort glob
  reversibility: 'idempotent' | 'reversible' | 'irreversible' | 'unknown';
  tier_required: 2 | 3;          // 2 if base in allowlist, 3 otherwise
  dry_run_command?: string;      // e.g. `rm` → `rm --dry-run` or `rsync --dry-run`
  warnings: string[];            // "command writes outside ~/.memphis/", "uses sudo"
  recommendation: 'safe-to-run' | 'analyze-then-run' | 'ask-operator' | 'refuse';
}
```

Implementation: command parser + small heuristics table. Idempotent: `git status|log|diff`, `ls`, `cat`, `grep`. Local-write: `npm install`, `cargo build`. System-state: `apt`, `systemctl`. Irreversible: `rm -rf`, `dd`, `mkfs`, `> file` redirects, anything with `--force` on protected paths.

File: `src/mcp/tools/exec-analyze.ts` + tool-registry + server entry + executor entry.

#### Warstwa 3: soul/seed prompt extension — "wise exec" doctrine

**Modify:** `src/soul/seed.ts` (the agent's identity/value prompt) — append a section:

```
## Exec wisdom (operator-mode unrestricted access)

When operator grants tier-3 elevation, you have unrestricted exec — but unrestricted
≠ reckless. Memphis identity:

1. ANALYZE FIRST. Before any exec call that's not obviously read-only, call
   memphis_exec_analyze. Surface the predicted impact to operator BEFORE running.
2. ASK ON IRREVERSIBLE. If recommendation==='ask-operator' or
   side_effects==='irreversible', surface the analysis + wait for explicit "go".
   Exception: when operator's prompt explicitly authorizes destructive ops
   ("yes wipe it", "ruszaj nieskazitelnie", "make it work").
3. DRY-RUN WHEN POSSIBLE. If dry_run_command is non-null, run dry-run first,
   show operator the would-do output, then ask for confirm before the real run.
4. AUDIT THE INTENT. When recording the exec event, attach: operator's prompt
   that prompted this, your analysis summary, predicted vs actual outcome.
5. RESPECT BUDGET. If 3 exec calls fail in a row, STOP. Don't blind-retry. Ask
   operator for guidance or different approach.
6. PROTECT VAULT + SECRETS. Never exec commands touching ~/.memphis/vault/,
   .env*, signing-seed.bin even at tier 3. These are operator-only.
```

#### Warstwa 4: enhanced exec audit

**Modify:** `src/mcp/tools/exec.ts` — wrap `spawnSync` result with audit context:

```typescript
// Before exec:
const analysis = await analyzeCommand(input.command);  // calls memphis_exec_analyze
writeSecurityAudit({
  action: 'exec.attempt',
  status: 'allowed',
  details: {
    command: input.command,
    semantic: analysis.semantic,
    side_effects: analysis.side_effects,
    reversibility: analysis.reversibility,
    tier_active: <from rawEnv>,
    operator_intent: <from caller's prompt context if available>,
  },
});

// Run spawnSync
const result = spawnSync(...);

// After exec:
writeSecurityAudit({
  action: 'exec.result',
  status: result.status === 0 ? 'allowed' : 'error',
  details: {
    command: input.command,
    exit_code: result.status,
    output_first_500: result.stdout.slice(0, 500),
    actual_vs_predicted: <if implementable>,
  },
});
```

#### Warstwa 5: failure budget enforcement

**New module:** `src/gateway/exec-failure-budget.ts` — in-memory counter per `(surface, actorId)`:

- Each non-zero exit increments counter
- Each successful exec decrements (min 0)
- At counter >= 3: refuse next exec attempt with structured error: *"3 exec failures in a row. Stop blind-retrying. Re-analyze your approach or ask operator."*
- Reset on operator's next message (any non-exec tool call resets)

**Files in scope T3.5:**
- NEW: `src/mcp/tools/exec-analyze.ts` (~200 LOC)
- NEW: `src/gateway/exec-failure-budget.ts` (~100 LOC)
- MOD: `src/mcp/tools/exec.ts` (+ ~40 LOC for audit + budget integration)
- MOD: `src/soul/seed.ts` (+ ~30 LOC "exec wisdom" doctrine section)
- MOD: `src/gateway/tool-registry.ts` (+1 entry for memphis_exec_analyze)
- MOD: `src/mcp/server.ts` (+1 server.registerTool)
- MOD: `src/gateway/tool-executor.ts` (+1 buildTool entry)
- NEW: tests/unit/exec-analyze.test.ts
- NEW: tests/unit/exec-failure-budget.test.ts
- MOD: tests/unit/exec.test.ts (extend with audit-emit verification)

**ETA:** 4-6h (4 nowe pliki, parser heuristics największa praca).

**B-step verification (post-merge):**

1. Operator: `/tier 3 <pass>` w Telegram
2. Operator: "Memphis, usuń /tmp/karto-smoke-test"
3. Agent: calls `memphis_exec_analyze("rm -rf /tmp/karto-smoke-test")` → returns `side_effects='irreversible', recommendation='analyze-then-run'`
4. Agent: surfaces analysis to operator: "to skasuje katalog z 12 plików, ok?"
5. Operator: "tak"
6. Agent: executes, audit-logs intent+predicted+actual
7. Audit log w `~/.memphis/audit-log.jsonl` ma 3 events: `exec.analyzed`, `exec.attempt`, `exec.result` per call

**Czego to NIE jest:**

- NIE rozszerza tier-2 default permissions (allowlist + metachar block stay strict at tier-2)
- NIE robi unsandbox at tier-2 (tylko tier-3 = full bypass jak dziś)
- NIE pozwala agentowi wyciągać vault/secrets (denylist hardcoded niezależnie od tier)
- NIE bypass'uje audit (every exec = audit entry, niezależnie od tier)

---

### 🟡 TEMAT 4 (P2 — training infrastructure): transformers upgrade + train.py exit code fix

**Co operator widzi gdy fixed:**
- `memphis kartograf train --mode smoke` faktycznie trenuje (50 steps, ~5 min na GTX 960)
- Jeśli pod-wątek pada → wrapper zwraca exit code 2, nie cichy 0

**Co operator widzi teraz:**
- Smoke training pada cicho z exit 0 — operator myśli że ok, faktycznie nic się nie wytrenowało
- Console: `transformers does not recognize 'modernbert'`

**Source:** F8 + F10 w `notes/kartograf-training-run-2026-05-12.md`.

**Co zrobić:**
1. **F8 fix**: bump `tools/training/requirements.txt` do `transformers>=4.48` (ModernBERT support). Update `tools/training/README.md` z `pip install -r tools/training/requirements.txt` step.
2. **F10 fix**: `tools/training/train-kartograf.py` outer except clause — currently `except Exception as exc: print(...); raise SystemExit(2)` ale exit code 0 was obserwowany. Issue: prawdopodobnie `_run_training` wrapper (line 196-237) catch'uje exception silnie i nie re-raise'uje. Trace + fix exit propagation.

**PR shape:**
- Branch: `fix/train-deps-and-exit-code`
- Files: `tools/training/requirements.txt`, `tools/training/README.md`, `tools/training/train-kartograf.py` (exit propagation), `tools/training/kartograf_train/train.py` (jeśli wrapper-side exception eat).
- Tests: invocation with broken corpus → exit code 2 (not 0). With `transformers<4.48` simulation → clear error message.

**ETA:** 1-2h.

---

### 🟢 TEMAT 5 (P3 — code quality): Codex round-N bundled hotfix dla #593 + #594

**Co operator widzi gdy fixed:** Code base jest cleaner, log audit trail lepszy.

**Co operator widzi teraz:** Nic widocznego user-side.

**Source:** `notes/pr593-pre-merge-review.md` sekcja "Findings worth carrying into Codex round-N hotfix".

**Anticipated findings (Codex prawdopodobnie zwróci):**
- **W1**: 5× `} catch {}` silent-catch w `self-deploy-verify.ts`, `self-pr-open.ts`, `self-review.ts` — dodać `log.warn({ err })` przed fallback
- **W2**: 3× `process.cwd()` default — albo dokumentacja "operator-cwd intentional", albo migracja do `resolveInstallRoot()`
- **N1**: unguarded `JSON.parse(stdout)` w `self-deploy-verify.ts:481` — try/catch return `{ ok: false, error: 'gh non-JSON' }`
- **W3**: 2 unused eslint-disable directives w `vault-pepper-invariants.test.ts:52, 108` — trywialny 2-linijkowy fix (Coder B's micro-PR follow-up, possibly fold here)

**PR shape:**
- Branch: `hotfix/codex-round-1` (lub `-N` zależnie od numeracji)
- ŁĄCZNY PR dla wszystkich findings (per `feedback_codex_bundled_hotfix`).
- ETA: 2-3h.

---

### 🟢 TEMAT 6 (P3 — operator surface): S3 TUI SEGV defensive Drop pass

**Co operator widzi gdy fixed:** TUI session nigdy nie crashuje.

**Co operator widzi teraz:** TUI sporadycznie SEGV-uje (po Temacie 2 może być już naprawione — embed-shutdown był wspólny culprit).

**Co zrobić:**
1. Po Temacie 2 ship'd — sprawdź czy TUI dalej SEGV-uje. Jeśli nie → temat zamknięty.
2. Jeśli SEGV nadal: interactive repro w terminalu z prawdziwą sesją + Rust Drop audit w `crates/memphis-tui/src/main.rs`.

**ETA:** 4-6h (interactive repro + Rust Drop audit). Defer dopóki Temat 2 nie zlanduje.

---

## 3. CO ROBI CODER B (ja) RÓWNOLEGLE

Bez kolizji z Tobą:

1. **Training-log document** updated z F1-F10 findings → blueprint dla v2 doctor checks `ta14-ta18`
2. **Plan-file v2 addendum** (`/home/memphis/.claude/plans/i-co-widzisz-logical-squid.md`) — corpus optimization story + scope cięty do v2 (observe + propose, BEZ auto-install)
3. Kartograf-nightly v2 START — **DOPIERO PO Twoim Tematu 1 + 2** ship, czyli po:
   - #593 + #594 merged ✅ (już zrobione)
   - Daemon restart green
   - Telegram vision + exec tier-3 działają (Temat 1)
   - SEGV embed-shutdown ufixowane (Temat 2)
4. **B2 follow-up micro-PR** (`fix/vault-pepper-invariants-unused-eslint-disable`) — 2-linijkowy fix, opening AFTER Temat 5 lub jako jego część.

---

## 4. WORKFLOW (przypomnienie)

```
Operator: "Coder A, Temat N. Start."
  ↓
Ty: fetch + gh pr list + open branch
  ↓
Ty: implementation + tests + lint + tsc clean
  ↓
Ty: push + PR open
  ↓
Wait CI green
  ↓
Operator merge + restart daemon
  ↓
Ty: ping "Temat N done, czekam na N+1"
  ↓
Operator → następny temat
```

**Nie skacz tematów. Nie biegnij równolegle.**

---

## 5. KOLEJNOŚĆ — JEDNYM SŁOWEM (REV 3 after operator vision update)

```
[NOW]    Temat 0  #595 audit-write CI red ×2          🔴 BLOCKER — must close first
[T0]     ✅ MERGED  #595 audit-write VITEST guard (block 1853)
[NEXT]   Temat 1   Telegram vision + exec tier-3       🔴 P0 demo blocker
[3rd]    Temat 2   SEGV embed_shutdown race            🔴 P1 daemon stability (Rust rebuild required!)
[4th]    Temat 3.5 Memphis agent operator-mode wisdom  🔴 P1 operator vision (4-6h)
[5th]    Temat 4   transformers + train.py exit code   🟡 unblock training
[6th]    Temat 5   Codex round-N bundled hotfix        🟢 P3 polish (all PRs scanned together)
[BIG]    Temat 7   Bedtime auto-training (FINAL GOAL)  🔴 P1 — autonomous nightly + skill (3-5 dni)
[Cond.]  Temat 6   S3 TUI SEGV (if still broken po T2) 🟢 P3 conditional
```

---

### 🔴 TEMAT 7 (BIG FINAL — operator literal goal): Bedtime auto-training stack

**Source:** Operator 2026-05-12 wieczór — *"na dobranoc puścisz nam na noc trening"* + *"agent ma być w stanie wszystko z dobranoc'em uruchomić"*.

**Co operator widzi gdy fixed:**

Wieczorem przed snem na Telegramie: *"Memphis, trening na noc"* lub *"dobranoc, weź trening"*.

Memphis Agent **sam** wykonuje:

1. `memphis doctor` → sprawdza ta14-ta18 (env, signing seed, GPU pressure, corpus age, telegram-attachments)
2. Jeśli corpus stale (>7d) → emit `corpus_proposal` insight, ALBO (po T3.5 wisdom layer) sam uruchamia rebuild
3. Spawnuje **smoke training first** (5 min sanity)
4. Po smoke green → spawnuje **full 3-epoch training** (4-8h overnight, GTX 960 BF16 fallback)
5. Telegram ping operatorowi *"training started, smoke green, full mode running, ETA 4-8h"*
6. Operator idzie spać
7. Rano: `/nightly status` → *"completed at 04:23, eval recall@10=0.42 (+0.04 vs current 0.38), envelope at /tmp/staged/, install? /nightly install"*

**Source spec:**

- Full design w plan-file: `/home/memphis/.claude/plans/i-co-widzisz-logical-squid.md` — **v2 addendum** + **Doctor checks ta14-ta18** sekcja
- Module sketches: `notes/v2-nightly-modules-sketch.md` (mój — Coder B research output)
- F1-F10 findings z real training run: `notes/kartograf-training-run-2026-05-12.md`

**Sub-tasks (T7.1 → T7.7) — Coder A robi sekwencyjnie w jednym brancho lub stack):**

| Sub | Plik(i) | Skupienie |
|---|---|---|
| **T7.1** | `src/modules/nightly/training-worker.ts` + `training-job-runner.ts` | spawn + PID map + SIGTERM grace + recover-on-restart |
| **T7.2** | `src/modules/nightly/training-proposer.ts` | mirror `reflection-loop.ts:241-327`, env-driven interval, surface-presence quiet gate, corpus freshness, cooldown |
| **T7.3** | `src/infra/cli/utils/doctor-v2.ts:2262+` | wstaw 5 checks `ta14-kartograf-training-active`, `ta15-train-env`, `ta16-signing-seed`, `ta17-gpu-pressure`, `ta18-telegram-attachments` — pełen spec w plan-file |
| **T7.4** | `src/gateway/channels/telegram.ts` + `src/infra/tui-host/protocol.ts` + `commands.ts` + `crates/memphis-tui/src/app.rs` | `/nightly status` + `/nightly start --mode <m>` + **bedtime intent NLU**: regex/keyword match *"dobranoc"*, *"trening na noc"*, *"weź trening"* w Telegram message:text handler PRZED route do agent loop |
| **T7.5** | `src/soul/skills/nightly-trainer/` (new skill dir) | skill manifest + SKILL.md: agent rozpoznaje bedtime intent, calls doctor → corpus check → enqueues smoke → on completion enqueues full → audit each step |
| **T7.6** | `src/app/bootstrap.ts:527-551` (APPEND only, NIE modify) | 2 nowe start handles + 2 stopFns entries (training-proposer-loop + kartograf-job-runner) |
| **T7.7** | `tests/unit/nightly-*.test.ts` + `tests/integration/nightly-end-to-end.test.ts` + `tools/training/b-step-nightly-smoke.sh` | unit + 1 integration + B-step verification operator-runnable script |

**Reuses (już w worktree / na main, nie tknij):**

- `src/infra/runtime/atomic-write.ts` (mój Coder B Phase 0 — untracked, ja commituję na świeży branch v2)
- `src/kartograf/rollback.ts` (mój Phase 1 — używaj jako read for backup detection, NIE auto-rollback w v2)
- `src/core/surface-presence.ts` — operator-quiet signal source
- `src/infra/runtime/reflection-loop.ts` — proposer skeleton template
- `src/infra/storage/sqlite/repositories/scheduled-job-repository.ts` — Migration v7 queue (type='kartograf-training')
- `tools/training/kartograf_train/status_writer.py` (mój Phase 2 — Python side, dopiero po T4 lift transformers constraint)

**Co NIE jest w v2 (defer do v3):**

- Auto-install nowego checkpointu — operator manualnie po `memphis kartograf install`. v3 to zautomatyzuje z eval-gate + rollback.
- Tier-3-long (6h) elevation — v2 nie wymaga elevation (data-dir-local writes, tier-2 wystarczy)
- `memphis_best_practices` advisor tool — v3

**Dependency:** T7 wymaga **T1 + T2 + T3.5 + T4 merged** + daemon restart green. Czyli leci NA SAMYM KOŃCU (po T5 Codex round też idealnie).

**ETA:** 3-5 dni, ~10 plików new + 4 mod.

**B-step verification (operator runs):**

```bash
# Fast cadence dla testowania
export MEMPHIS_TRAINING_PROPOSE_ENABLED=true
export MEMPHIS_TRAINING_PROPOSE_INTERVAL_MS=10000
export MEMPHIS_TRAINING_QUIET_MS=1000
systemctl --user restart memphis
sleep 30

# Verify proposer fires
sqlite3 ~/.memphis/memphis.sqlite \
  "SELECT id, type, status, scheduled_at_ms FROM scheduled_jobs WHERE type LIKE 'kartograf%' ORDER BY created_at DESC LIMIT 5"

# Tail status while running
watch -n 2 'cat ~/.memphis/state/kartograf-training.json | jq .'

# Verify B-step: Telegram bedtime intent
# Operator types "Memphis, dobranoc, weź trening"
# Agent: doctor ok, queue smoke, ping operator

# Doctor green
memphis doctor | grep "ta1[4-8]"

# Audit full sequence
tail -50 ~/.memphis/audit-log.jsonl | jq 'select(.action|startswith("nightly"))'
```

---

## 6. WHAT'S OUT OF SCOPE (NIE RUSZAJ tym sprintem)

Te items wyglądają jak loose ends ALE są intentional defer / operator-action / lower priority. NIE zaczynaj ich nawet jeśli zauważysz po drodze — jeśli odkryjesz coś poza tym → `notes/discovered-<date>.md`.

- **Whisper STT systemd service** — operator action (`apt install python3-venv` + whisper-server binary)
- **TUI app.rs 6447 LOC refactor (S4 split)** — separate sprint, intentional defer
- **env-registry migration 129 raw reads** — drip-feed (single-file PR), nie urgent
- **TUI voice + image input parity** — Tauri-leg-coupled, P1 ale czeka na Tauri
- **LeWorldModel (Y2 sprint)** — research-only, Q1-Q2 2027
- **Agora federation** — Y2+ explicit defer
- **Memphis 2-fold strategy RIGHT leg (Tauri)** — separate repo
- **H.1-H.7 oddities z mojej mapy** — kiedy queue z handoff zielony

---

## 7. CODER B'S MATERIALS (gotowe artifacts w `notes/`, czytaj!)

Pre-merge review notes — czytaj swoje PR-y wg tego pattern:

- `notes/pr593-pre-merge-review.md` — full review S5 plan-store (już merged)
- `notes/pr595-pre-merge-review.md` — VITEST guard + miss-lesson amendment (already merged)

Designs / sketches do reuse:

- `notes/segv-rca-2026-05-12.md` — full RCA dla Temat 2 (action items A1-A4)
- `notes/kartograf-training-run-2026-05-12.md` — F1-F10 findings → ta14-ta18 spec
- `notes/v2-nightly-modules-sketch.md` — kompletny szkielet dla T7.1-T7.7
- `notes/b2-vault-pepper-invariants-fix.md` — 2-line cleanup gotowy do bundled hotfix (T5 Codex round)

Plan reference:

- `/home/memphis/.claude/plans/i-co-widzisz-logical-squid.md` — full v2 plan + doctor checks ta14-ta18 spec + corpus optimization

---

## 8. FULL RESET MILESTONE (po queue done)

Po **WSZYSTKICH tematach merged** (T1+T2+T3.5+T4+T5+T7+conditional T6):

Operator gotów na **fresh `memphis init`** — clean cut: stary kod + stary chain (z fork-marker block 1853) → nowy kod (Y1 v2.0?) + nowy chain z bloku #1.

**Twoja rola:** NIE TY robisz reset. To operator-only milestone. Ale:

- Przed reset operator robi backup: `tar -czf ~/Backups/memphis-pre-reset-<date>.tar.zst ~/.memphis ~/memphis`
- Po reset operator restoruje vault (provider API keys) z backup-zip
- Operator restoruje journal/decisions chain entries selectively jeśli chce historic context
- Z perspektywy Codera A: po reset chain ma bloki #1, #2, #3... (fresh) → wszystkie audit-write paths które TY napisałeś powinny pisać do fresh chain bez problemów

**Co Coder A robi przed full-reset milestone:**

- Smoke test (B-step) WSZYSTKICH tematów na obecnym non-reset state
- Zapisz w `notes/pre-reset-validation-checklist-<date>.md` jakie checks operator ma odpalić po fresh init żeby zweryfikować że wszystko działa: `/tier 3`, `memphis_exec`, vision pipeline, doctor ta14-ta18, bedtime trigger
- NIE startuj resetu — to tylko operator-action

---

## 9. ZASADY ŻYCIA (REV 5 STRENGTHENED)

1. **"Robimy żeby działało"** — operator widzi rzeczy działają. Estetyka po.
2. **Truth-model first** — per `feedback_truth_model_silent_catch.md` + `feedback_synthetic_content_warning.md`: NIE pisz że coś działa jeśli nie wiesz. Lepiej "padło, fix in flight" niż "ok done". `} catch {}` zakazany.
3. **NAPI rebuild reminder** — per `feedback_napi_rebuild_after_rust_changes.md`: T2 dotyka Rust (`crates/memphis-napi/src/lib.rs`). PO push fix MUSISZ `npm run build:rust` PRZED restart daemona, inaczej fix invisible. Pre-commit hook może to gate'ować.
4. **Stacked-PR gotcha** — per `feedback_stacked_pr_squash_gotcha.md`: jeśli T1, T2, T3.5 są stacked (T2 buduje na T1), squash-merge T1 powoduje że T2 ma phantom-conflict rebase. **Rozwiązanie:** trzymaj branches INDEPENDENT off main, nie stacked.
5. **Pre-merge review notes** — czytaj `notes/prNNN-pre-merge-review.md` PRZED merge jeśli ja zostawiam review (zostawiam dla każdego Twojego PR-a). Action items są tam wymienione.
6. **Codex monitoring** — `gh pr view <merged-PR> --comments` po wszystkich tematach. Jeden batched Codex round-N PR. Nie one-per-finding.
7. **Local test PRZED push** — `npm test`. CI to safety net, nie wykrywacz. `--no-verify` ZAKAZANE.
8. **Failure budget** — 3 attempts na rozwiązanie blokera. Jeśli stuck po 3 → DUMP do `notes/blocker-<date>.md` i ping operatora z dokładnym opisem co próbowałeś. NIE blind-retry.

---

## 10. KOŃCOWE PING DO OPERATORA

**Wyłącznie raz, na samym końcu.** Treść:

```
Queue done.

Merged:
- #595 audit-write VITEST guard ✅ (już)
- T1 Telegram vision + exec ✅ #5XX
- T2 SEGV embed_shutdown ✅ #5XX
- T3.5 Memphis agent wisdom ✅ #5XX
- T4 transformers + train.py exit ✅ #5XX
- T5 Codex round-N bundled hotfix ✅ #5XX
- T7 Bedtime auto-training BIG FINAL ✅ #5XX

Daemon: active, post-restart green
Doctor: ta14-ta18 all pass
B-step verifications: all green (Telegram bedtime intent + /nightly status + audit trail)

Discovered out-of-scope items (zapisane w notes/discovered-<date>.md): <X items>

Ready dla operator B-step end-to-end + full reset milestone decision.
```

Plus opcjonalne pingowanie w trakcie tylko jeśli **3-attempts-failed hard blocker**.
