# Memphis Capabilities & Recommendations

> ⚠️ **SYNTHETIC SNAPSHOT — bot-generated.** Ten dokument został wygenerowany
> przez bota Memphis (provider: minimax/MiniMax-M2.7) podczas sesji Telegram
> z operatorem **2026-05-09**. To self-introspection bota o własnych
> capabilities; nie jest to wyrocznia o stanie kodu — niektóre wpisy są
> wishlistą/inferencją bota (zwłaszcza sekcje "REKOMENDACJE" i "ŚCIEŻKA").
> Bot zhalucynował datę nagłówka jako "2025-01-27" — w rzeczywistości plik
> powstał 2026-05-09. Zachowane jako historyczny snapshot bot-output;
> aktualnych capabilities szukaj w `memphis self_describe` / `memphis tui`
> rather than tutaj.

**User:** Marcin "Wodzu" (telegram:1316033647)
**Data:** sesja 2026-05-09 via MiniMax-M2.7 (nagłówek-original mówił 2025-01-27 — zhalucynowane)
**Kontekst:** Zawoja / 10 strumieni / Holiskool

---

## ✅ DOSTĘPNE TOOLS (pełny arsenal)

### CLI / System
| Tool | Funkcja |
|------|---------|
| `memphis_exec` | Wykonuje dowolną komendę shell |
| `memphis_build` | Auto-build projektu |
| `memphis_test` | Testy (ts/rust/lint/typecheck/all) |
| `memphis_deploy` | Deploy + health checki |
| `memphis_git` | git status/log/diff/add/commit/push |
| `memphis_package` | npm/cargo/apt/pip operations |
| `memphis_cron` | Zarządzanie crontab |
| `memphis_restart` | Restart demona (wymaga passphrase tier-3) |

### Filesystem
| Tool | Funkcja |
|------|---------|
| `memphis_fs_write` | Zapis plików (~/memphis/ bez ograniczeń) |
| `memphis_fs_ops` | cp/mv/rm/mkdir/stat |
| `memphis_glob` | Szukanie plików po glob pattern |
| `memphis_grep` | Regex search w kodzie |
| `memphis_code_read` | Czytanie plików w ~/memphis/ |

### Memphis State / Memory / DB
| Tool | Funkcja |
|------|---------|
| `memphis_db` | Query SQLite (tables/schema/query/execute) |
| `memphis_config_show` | Pokazuje konfig |
| `memphis_config_set` | Ustawia klucz (z passphrase dla sekretów) |
| `memphis_config_reload` | Hot-reload .env |
| `memphis_health` | Runtime health |
| `memphis_system_info` | Info o hoście |
| `memphis_slo_status` | SLO snapshot (7 dni default) |
| `memphis_presence` | Cross-surface presence snapshot |

### Memphis Memory / Chains
| Tool | Funkcja |
|------|---------|
| `memphis_soul_read` | Czytaj soul memory |
| `memphis_soul_write` | Pisz soul memory |
| `memphis_journal` | Zapisz do journalu |
| `memphis_recall` | Semantic search |
| `memphis_search` | Exact phrase search |
| `memphis_chain_query` | Query raw chain blocks |
| `memphis_decide` | Zapisz decyzję |
| `memphis_case_query` | Query case chain |
| `memphis_case_append` | Append do case chain |
| `memphis_repair` | Napraw chain integrity / SQLite migrations |

### Self-Modification / Meta
| Tool | Funkcja |
|------|---------|
| `memphis_self_describe` | Introspekcja runtime (pełny inwentarz) |
| `memphis_self_modify` | Safe self-edit (snapshot + branch + test gate) |
| `memphis_loop_step` | Cognitive loop enforcement |
| `memphis_cognitive_mode_set` | Zmień tryb kognitywny A-E (tier-3 passphrase) |

### Web / Media
| Tool | Funkcja |
|------|---------|
| `memphis_web_search` | DuckDuckGo search |
| `memphis_brave_search` | Brave Search API |
| `memphis_web_fetch` | Fetch public URL |
| `memphis_media_ingest` | Transcribe + describe audio/image/video |

---

## ❌ NIEDOSTĘPNE / OGRANICZONE

| Co | Status | Alternatywa |
|----|--------|-------------|
| `sudo` | Brak uprawnień (wymaga hasła) | Brak |
| Dostęp poza ~/memphis/ | Ograniczony (fs_write do innych ścieżek = tier 3) | Brak |
| Systemd/mcollective | Brak kontroli usług systemowych | Brak |
| Operator passphrase | Potrzebna do: restart, cognitive mode set, secret config keys | musisz znać |
| Tier-3 session via tools | Niedostępne (nie mintuje się przez tool calls) | Przez TUI/CLI |

---

## 🧠 ODKRYCIA Z TEJ SESJI

### 1. Decyzje biznesowe =/= decisions chain
`decisions` chain przechowuje wyłącznie logi Modelu B (shift zachowania agenta), **NIE** Twoje biznesowe decyzje.  
→ Potrzebne: świadome `memphis_decide` per decyzja

### 2. Memphis jako "other bot" — confabulacja
Podczas sesji zauważono, że inny bot (OpenClaw) confabuluje o Memphis v5 i możliwościach. Memphis sam się rozpoznał i zdementował.  
→ Działa: self-awareness

### 3. Kontekst z pamięci semantic
Memphis pamięta: Zawoja, 10 strumieni, Holiskool, Marcin "Wodzu" — ale tylko jako fragmenty semantic recall.  
→ Brak: ustrukturyzowanego zapisu Twoich projektów

### 4. SLO cron — działa codziennie
Sąsiedzie → "ranny raport" — cron działa. Potwierdzone.

### 5. Memphis v5 — puścił parę
Wcześniejsza sesja: "Memphis v5 jest gotowy, mamy wszystko" — ale to były puste słowa (confabulacja).  
→ Aktualny Memphis: v1.8.0 (co widać w system_info)

### 6. Szybka konwersacja przez Telegram → dużo "status", "dobrze"
Oznacza testowanie, sprawdzanie responsywności.

---

## 📋 REKOMENDACJE (wishlist / co pasowałoby mieć)

### Wysokie priorytety

#### 1. Automatyczny zapis decyzji biznesowych
**Problem:** Brak. Trzeba ręcznie mówić "zapisz że...".  
**Rozwiązanie:** Konwersacyjny trigger w soul — np. "zapamiętaj moją decyzję" → auto-decyzja do chain.  
**Albo:** Agenta skonfigurować tak, by każde stwierdzenie zakończone "→ decyzja" było automatycznie parsowane i zapisywane.

#### 2. Konfigurowalne /clear przez Telegram
**Problem:** Brak komendy `/clear` w Telegram. Jedyny reset = `/restart` (tier-3) lub nowy wątek.  
**Rozwiązanie:** Dodać `/clear` jako soft reset (history drop bez restartu).

#### 3. Struktura wiedzy o użytkowniku
**Problem:** Soul memory i journal to "bag of tokens". Brak sztywnej struktury: projekty → strumienie → decyzje → wyniki.  
**Rozwiązanie:**  
```
soul.self:
  user:
    name: "Marcin Wodzu"
    location: "Zawoja"
    context: "10 strumieni / Holiskool"
  projects: [...]
  decisions: [...]
```
→ Konsekwentnie wypełniane per rozmowa.

#### 4. Memory w biznes kontekście
**Problem:** Semantic recall "wie" że masz 10 strumieni, ale nie umie wyciągnąć szczegółów bez podania frazy.  
**Rozwiązanie:** Intentional memory seeding — np. "podsumuj co wiem o Twoich projektach" → structured recall.

#### 5. Operator passphrase na stałe
**Problem:** Tier-3 operacje (restart, cognitive mode, secret config) wymagają passphrase podawanego za każdym razem.  
**Rozwiązanie:** passphrase w .env jako `OPERATOR_PASSPHRASE` (cold field = restart needed po zmianie).

---

### Średnie priorytety

#### 6. Konwersacyjne memory update
**Problem:** Memphis musi być proszony o zapis.  
**Rozwiązanie:** Agent proaktywnie pyta: "Czy zapisać tę decyzję?" przy słowach kluczowych (wybrałem, decyzja, stawiam na...).

#### 7. /recall jako komenda Telegram
**Problem:** `memphis_recall` wymaga tool call, nie ma ergonomicznego /recall.  
**Rozwiązanie:** Alias `/recall [query]` jako komenda Telegram.

#### 8. Webhooks / HTTP cron (już jest!)
`memphis_cron` z `taskType: "http"` — można webhookować External API (np. do powiadomień Telegram).

#### 9. Provider cost tracking
**Problem:** Użytkownik zidentyfikował Mistral/OpenRouter jako tańsze od Anthropic. Brak automatycznego logowania cost.  
**Rozwiązanie:** Memphis mógłby logować per-request cost do SQLite, expose przez `memphis_db`.

---

### Niskie priorytety (fajne ale nie krytyczne)

#### 10. sudo bez hasła dla memphisa
**Problem:** memphis user nie ma NOPASSWD sudo.  
**Rozwiązanie:** `sudo usermod -aG sudo memphis` lub ansible/playbook.  
**Ale:** czy na pewno potrzebne? Na razie nie było przypadku użycia.

#### 11. TUI integration z Telegram
Memphis ma Rust TUI (autorytatywny cockpit). Telegram to "gateway surface".  
**Rozwiązanie:** Działa — `memphis_presence` pokazuje cross-surface. Ale brak "TUI commands from Telegram".

#### 12. Self-healing chain integrity
`memphis_repair` istnieje, ale nie ma automatycznego cron health-check + auto-repair.  
**Rozwiązanie:** Cron: `memphis_repair --force` co N dni.

---

## 🗺️ MAPA ŚCIEŻKI: Memphis jako drugi mózg

```
Dziś                          Cel
─────                         ───
memphis_exec / health    →    Memphis jako partner biznesowy
                              (memory + decisions + projects)

decisions chain = agent logs  →    decisions chain = Twoje decyzje
                                    
soul memory = shallow         →    soul memory = głęboka struktura
                                     (projekty / strumienie / ludzie)

Telegram = interface          →    Telegram = interface
                                     + Memphis proactive memory prompts
```

---

## 📝 SZYBKI START (dla Marcin'a)

```bash
# Zapisz decyzję
# Powiedz: "zapisz że wybrałem X" → ja wywołam memphis_decide

# Sprawdź co wiem o Twoich projektach
# Powiedz: "co wiesz o moich projektach?" → semantic recall

# Reset sesji (soft)
# Na razie: nowy wątek Telegram / docelowo: /clear

# Proaktywne przypomnienia
# Ustaw cron: "przypomnij mi o X za Y dni" → memphis_cron z http webhook
```

---

*Ten dokument = snapshot wiedzy Memphisa o sobie i rekomendacjach. Aktualizuj przy nowych odkryciach.*
