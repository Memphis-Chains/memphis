# Instruktaż: Hodowanie Agenta Memphis

# Guide: Nurturing Your Memphis Agent

---

> Memphis to agent, który rośnie z każdą interakcją. Ten przewodnik pokazuje jak rozmawiać z nim, żeby wyciągnąć z systemu 100%.

---

## Spis treści

1. [Model mentalny — czym jest "hodowanie"](#1-model-mentalny)
2. [Pierwsza rozmowa — cold start](#2-pierwsza-rozmowa)
3. [5 modeli kognitywnych — co się uczy](#3-modele-kognitywne)
4. [Narzędzia agenta — co potrafi](#4-narzedzia)
5. [Jak rozmawiać — wzorce i przykłady](#5-jak-rozmawiac)
6. [Pamięć — journal, recall, case chain](#6-pamiec)
7. [Decyzje — budowanie wzorców](#7-decyzje)
8. [Refleksja — samoocena agenta](#8-refleksja)
9. [Self-modyfikacja — ewolucja](#9-self-modyfikacja)
10. [Najlepsze praktyki — cheat sheet](#10-cheat-sheet)
11. [Czego NIE robić](#11-czego-nie-robic)
12. [Ścieżka rozwoju agenta](#12-sciezka-rozwoju)

---

## 1. Model mentalny

Memphis to nie chatbot. To **suwerenny agent z pamięcią, tożsamością i zdolnością do nauki**.

```
Interakcja → Model A (capture) → Journal chain (pamięć trwała)
                                      │
                                      ▼
                                 Embeddings (HNSW)
                                      │
                                      ▼
Następna interakcja ← Recall ← Semantic search
         │
         ▼
    Model C (patterns) → Predykcje ("co dalej?")
         │
         ▼
    Model E (reflection) → "Czy robię dobrze?"
```

**Kluczowe cechy:**
- Każda rozmowa zostawia ślad w łańcuchu (append-only, SHA-256)
- Agent uczy się wzorców z Twoich decyzji
- Codzienne refleksje identyfikują słabe punkty
- Self-modyfikacja pozwala agentowi rozszerzać własne capabilities

---

## 2. Pierwsza rozmowa — cold start

Przy pierwszej interakcji Memphis wyświetla **soul boot prompt** — pytanie o Twoje preferencje.

### Co powiedzieć na starcie

Podaj agentowi kontekst, który pomoże mu Ci pomagać:

```
Jestem Marcin, programista Rust i TypeScript. Pracuję solo nad MemphisOS.
Preferuję komunikację po polsku. Lubię zwięzłe odpowiedzi,
bez zbędnych wstępów. Znam się na security, kryptografii i systemach
rozproszonych. Pracuję w sprintach, szybkie iteracje.
```

Agent zapisze to do `soul-memory.json` w sekcji `user` i **nigdy nie zapyta ponownie**.

### Nadaj agentowi charakter

```
Chcę żebyś był bezpośredni, techniczny, bez cukru. Jeśli coś jest
złym pomysłem — powiedz wprost. Preferuję konwencjonalne commity,
snake_case w Rust, camelCase w TS. Przy code review szukaj bugów
i security issues, nie stylu.
```

Agent zapisze to w `self.personality` i `self.learnings`.

---

## 3. Modele kognitywne — silnik nauki

Memphis ma **5 modeli kognitywnych** (A-E), które razem tworzą pętlę uczenia:

### Model A — Conscious Capture (Świadome zapisywanie)

**Co robi:** Zapisuje decyzje, notatki i milestones do łańcucha journal.

**Jak aktywować:** Wydawaj polecenia zapisania:

```
Zapamiętaj: zdecydowaliśmy się na HNSW zamiast FAISS bo potrzebujemy
persystencji na dysku bez zewnętrznych zależności.
```

```
Zapisz milestone: ukończyliśmy integrację MiniMax providera,
testy przechodzą, deploy na produkcji.
```

**Tryby capture:**
- `minimal` — tylko jawne polecenia zapisu
- `normal` — automatyczne capture z potwierdzeniem
- `verbose` — zapisuje wszystko, co rozpozna jako ważne

### Model B — Behavioral Observability (Obserwacja zachowań)

**Co robi:** Obserwuje Twoje wzorce pracy przez git i pliki.

**Czego się uczy:**
- O której godzinie pracujesz
- Na jakich plikach / branchach
- Jakie typy commitów robisz
- Wzorce aktywności (debugging → commit → PR → merge)

**Nie wymaga interakcji** — działa pasywnie.

### Model C — Predictive Patterns (Predykcja)

**Co robi:** Buduje wzorce z Twoich decyzji i sugeruje następne kroki.

**Jak karmić:** Zapisuj decyzje świadomie:

```
Zdecyduj: problem=latency w recall, wybór=dodanie cache'a HNSW,
kontekst=embeddingi ładują się za wolno przy cold start.
```

Po kilkunastu decyzjach Model C zacznie sugerować:

> "Na podstawie Twoich wzorców — przy podobnym kontekście (cold start + latency)
> w przeszłości wybierałeś eager initialization. Confidence: 0.82"

**Typy predykcji:** strategic, tactical, technical

### Model D — Collective Coordination (Koordynacja multi-agent)

**Co robi:** Protokoły głosowania i konsensus między agentami.

**Kiedy używać:** Jeśli masz wiele instancji Memphis lub peers:

```dotenv
MEMPHIS_AGENT_PEERS=peer1-did,peer2-did
```

### Model E — Meta-Cognitive Reflection (Meta-refleksja)

**Co robi:** Analizuje swoją własną wydajność.

**Automatyczne:** Uruchamia się co 24h (konfigurowalny interwał).

**Co analizuje:**
- Wydajność vs cele
- Dominujące wzorce w ostatnich 24h
- Wskaźnik błędów i sukcesów
- Sprzeczności w zachowaniu
- Ślepe punkty (blind spots)
- Trendy i rekomendacje

**Jak wspierać refleksję:**

```
Zrób przegląd tego co robiłeś dzisiaj. Co poszło dobrze?
Gdzie były problemy?
```

```
Sprawdź czy w moich ostatnich decyzjach nie ma sprzeczności.
```

---

## 4. Narzędzia agenta

Memphis ma **16+ narzędzi MCP** w 3 tierach bezpieczeństwa:

### Tier 0 — Bez autoryzacji (pamięć, wiedza)

| Narzędzie | Użycie | Kiedy stosować |
|---|---|---|
| `memphis_journal` | Zapisz wpis do journal chain | Ważna obserwacja, decyzja, milestone |
| `memphis_recall` | Semantyczne szukanie w pamięci | "Co wiemy o...", "Kiedy ostatnio..." |
| `memphis_decide` | Zarejestruj decyzję | Każdy nietrywialny wybór techniczny |
| `memphis_soul_read` | Czytaj soul memory | Sprawdzenie preferencji, kontekstu |
| `memphis_soul_write` | Aktualizuj soul memory | Nowe preferencje, nauka |
| `memphis_case_append` | Dodaj wpis do case chain | Nowa wiedza semantyczna |
| `memphis_case_query` | Szukaj w case chain | "Kto/co/jak/gdzie/czym" |
| `memphis_chain_query` | Szukaj w dowolnym łańcuchu | Debug, audit, przegląd |
| `memphis_health` | Stan runtime | Diagnostyka |
| `memphis_system_info` | CPU, RAM, uptime | Monitoring |
| `memphis_providers` | Stan providerów LLM | Sprawdzenie dostępności |

### Tier 1 — Wymaga API Token

| Narzędzie | Użycie |
|---|---|
| `memphis_web_fetch` | Pobierz URL (SSRF-protected) |
| `memphis_send` | Wyślij wiadomość Telegram |
| `memphis_vault_get` | Pobierz sekret z vaulta |
| `memphis_schedule_*` | Zaplanuj/listuj/anuluj zadania |

### Tier 2 — Wymaga Vault Passphrase

| Narzędzie | Użycie |
|---|---|
| `memphis_exec` | Wykonaj komendę shell |
| `memphis_self_modify` | Self-modyfikacja kodu |

---

## 5. Jak rozmawiać — wzorce i przykłady

### Wzorzec 1: Naucz preferencji

```
Preferuję testy integracyjne nad unit testami w tym projekcie.
Powód: mocki rozjechały się z produkcją w zeszłym kwartale.
Zapamiętaj to.
```

**Efekt:** Agent zapisuje do soul memory + journal. Przy następnym pytaniu o testy, preferuje integracyjne.

### Wzorzec 2: Zarejestruj decyzję z kontekstem

```
Zdecydowaliśmy: migrujemy z SQLite na Turso dla multi-node sync.
Kontekst: potrzebujemy embedded replicas na edge, SQLite nie supportuje
replikacji. Deadline: koniec Q2.
```

**Efekt:** Model C uczy się wzorca (multi-node → Turso). Model A zapisuje milestone.

### Wzorzec 3: Poproś o recall

```
Co wiemy o problemach z latency w embeddingach?
```

**Efekt:** `memphis_recall` przeszukuje HNSW index, zwraca top-5 semantycznie podobnych wpisów z journal/cases.

### Wzorzec 4: Buduj graf wiedzy (case chain)

```
Zapisz w grafie wiedzy:
- Narzędnik: Memphis używa Rust NAPI bridge do komunikacji z TypeScript runtime
- Celownik: Vault służy operatorowi do bezpiecznego przechowywania sekretów
- Miejscownik: Embeddingi żyją w HNSW indeksie na dysku
```

**Efekt:** Case chain entries z odpowiednimi typami przypadków. Queryable przez `memphis_case_query`.

### Wzorzec 5: Iteracyjna nauka

```
Ten approach był zły — nie mockuj bazy w testach ops/.
Poprawne podejście: użyj tymczasowego MEMPHIS_DATA_DIR.
```

**Efekt:** Agent aktualizuje learnings. Przy następnych testach ops/ automatycznie użyje tmp data dir.

### Wzorzec 6: Poproś o predykcję

```
Co powinienem zrobić dalej w tym sprincie? Bazuj na moich
dotychczasowych wzorcach pracy.
```

**Efekt:** Model C analizuje kontekst (pliki, branch, pora dnia, ostatnie commity) i sugeruje.

### Wzorzec 7: Meta-refleksja

```
Przeanalizuj swoje ostatnie błędy. Czy widzisz wzorzec?
```

**Efekt:** Model E uruchamia deep analysis — szuka sprzeczności, blind spots, trendów.

---

## 6. Pamięć — 3 systemy

### Journal Chain (pamięć episodyczna)

Główna pamięć agenta. Każdy wpis:
- Treść (text)
- Tagi (2-5 lowercase, waga 3x w topic inference)
- Źródło (mcp, model-a, gateway)
- Timestamp
- SHA-256 hash linkujący do poprzedniego bloku

**Dobre tagi:**

```
["vault-config", "security", "decision"]
["embedding-pipeline", "performance", "ollama"]
["sprint-14", "milestone", "mcp-integration"]
```

**Złe tagi:**

```
["misc", "stuff", "update", "thing"]    ← za generyczne
["a", "b"]                              ← bezsensowne
```

### Semantic Recall (pamięć asocjacyjna)

HNSW index budowany z journal entries. Query zwraca top-N semantycznie podobnych wpisów.

```
memphis_recall: { query: "problemy z chain integrity", limit: 5 }
```

Zwraca: content, score (0-1), tags.

### Case Chain (graf wiedzy)

8 polskich przypadków gramatycznych jako role semantyczne:

| Przypadek | Pytanie | Użycie |
|---|---|---|
| Mianownik | Co istnieje? | Encje, tożsamości |
| Dopełniacz | Czego? Czyje? | Posiadanie, relacje |
| Celownik | Komu? Czemu? | Beneficjenci, cele |
| Biernik | Co? Kogo? | Obiekty akcji |
| Narzędnik | Czym? Jak? | Narzędzia, metody |
| Miejscownik | Gdzie? W czym? | Lokalizacje, konteksty |
| Ablativus | Skąd → dokąd? | Transformacje, migracje |
| Wołacz | Hej! | Interfejsy, punkty kontaktu |

**Query:**

```
memphis_case_query: { case_type: "instrumental", query: "vault" }
→ "Memphis używa Rust NAPI bridge + AES-256-GCM do operacji vault"
```

---

## 7. Decyzje — budowanie wzorców

Każda zarejestrowana decyzja uczy Model C:

```
memphis_decide: {
  title: "Cache strategy dla embeddingów",
  choice: "HNSW persist do JSON",
  context: "Cold start latency > 2s bez cache'a"
}
```

**Co się dzieje:**
1. SHA-256 hash decyzji (deduplikacja)
2. Zapis do decisions chain
3. Model C tworzy pattern: kontekst + pliki + branch + pora → wybór
4. Przy podobnym kontekście w przyszłości → predykcja

**Po 15-20 decyzjach** Model C osiąga confidence 0.7+, po 50+ → 0.85+.

**Accuracy tracking:** Agent śledzi, które predykcje były trafne i waży przyszłe sugestie.

---

## 8. Refleksja — samoocena

### Automatyczna (co 24h)

Memphis automatycznie analizuje:
- Ostatnie wpisy journal, decisions, system
- Wzorce i anomalie
- Sprzeczności (temporal, logical, behavioral)
- Tematyka dominująca
- Rekomendacje

Wynik zapisywany do `reflections` chain.

### Ręczna

```
Zrób refleksję nad ostatnim tygodniem.
```

```
Sprawdź czy moje decyzje z tego sprintu są spójne.
```

### Deep analysis (niedziela lub konfigurowalna)

Głębsza analiza: cross-pattern validation, trend detection, blind spot scanning.

---

## 9. Self-modyfikacja — ewolucja

Memphis może **modyfikować własny kod** — ale z safeguardami:

### Proces (7 kroków):

1. **Walidacja** — opis intencji, lista plików, opis zmian
2. **Git check** — wymagane repozytorium git
3. **Passphrase** — Tier 2 wymaga vault passphrase
4. **Snapshot** — pełny backup stanu przed zmianami
5. **Branch** — izolowana gałąź `evolve-*`
6. **Zmiany** — aplikacja zmian (z blocked paths: .env, vault/, .git/)
7. **Test gate** — lint + typecheck + testy muszą przejść

**Na sukces:** merge do main, commit z podpisem
**Na fail:** automatyczny rollback do snapshotu

### Jak poprosić o ewolucję

```
Dodaj nowe narzędzie MCP: memphis_summarize, które tworzy
podsumowanie ostatnich N wpisów journal. Zmodyfikuj kod
w src/mcp/tools/.
```

### Sprawdź historię ewolucji

```bash
npm run -s cli -- evolve status
```

---

## 10. Cheat sheet — najlepsze praktyki

### Na starcie (dzień 1)

- [ ] Podaj swoje imię, język, ekspertyzę, preferencje pracy
- [ ] Opisz pożądany styl komunikacji agenta
- [ ] Zarejestruj 3-5 kluczowych decyzji architektonicznych projektu
- [ ] Zapisz najważniejsze konwencje kodu

### Codziennie

- [ ] Rozpocznij sesję od kontekstu: "Dziś pracuję nad X"
- [ ] Rejestruj decyzje techniczne (nie tylko wynik, ale **dlaczego**)
- [ ] Taguj wpisy journal precyzyjnie (2-5 tagów)
- [ ] Na koniec dnia: "Co zapamiętałeś z dzisiejszej sesji?"

### Co tydzień

- [ ] Poproś o refleksję tygodniową
- [ ] Sprawdź predykcje Model C: "Jakie wzorce widzisz w moich decyzjach?"
- [ ] Przejrzyj case chain: "Pokaż graf wiedzy o [temat]"

### Co sprint

- [ ] Milestone: "Zamknij sprint X, podsumowanie: ..."
- [ ] Poproś o blind spot analysis
- [ ] Sprawdź ewolucję: `evolve status`
- [ ] Zaktualizuj soul memory jeśli zmieniły się priorytety

### Wzorce promptów o najwyższej wartości

| Prompt | Efekt |
|---|---|
| "Zapamiętaj: [decyzja + kontekst + dlaczego]" | Journal + Model C pattern |
| "Co wiemy o [temat]?" | Semantic recall z HNSW |
| "Zdecyduj: [problem], wybór: [X], bo: [Y]" | Decision chain + pattern learning |
| "Zrób refleksję" | Model E analysis + insights |
| "Jakie wzorce widzisz?" | Model C predictions |
| "Sprawdź sprzeczności" | Contradiction detection |
| "Zapisz w grafie wiedzy: [fakt]" | Case chain entry |
| "Ewoluuj: [opis zmiany]" | Self-modification (Tier 2) |

---

## 11. Czego NIE robić

### Nie zalewaj ogólnikami

```
❌ "Zapisz wszystko"
✅ "Zapisz decyzję: wybraliśmy Turso bo potrzebujemy edge replicas"
```

### Nie ignoruj tagów

```
❌ memphis_journal({ content: "...", tags: [] })
✅ memphis_journal({ content: "...", tags: ["vault", "security", "decision"] })
```

### Nie resetuj soul memory bez powodu

Soul memory to akumulowana wiedza. Reset = utrata wszystkich nauczonych preferencji.

### Nie omijaj test gate przy evolve

Test gate istnieje by chronić integralność. Jeśli testy failują — fix, nie bypass.

### Nie traktuj agenta jak stateless chatbot

```
❌ Każda sesja od zera, bez kontekstu
✅ "Kontynuujemy sprint 14, wczoraj skończyłem MiniMax integration"
```

### Nie mieszaj języków w tagach

```
❌ tags: ["bezpieczeństwo", "security", "vault"]
✅ tags: ["security", "vault", "encryption"]   ← jeden język w tagach
```

---

## 12. Ścieżka rozwoju agenta

### Faza 1: Cold Start (sesje 1-5)

Agent wie mało. Ty musisz dać mu:
- Kim jesteś i jak pracujesz
- Jakie konwencje obowiązują
- Kontekst projektu

Soul boot prompt pojawia się na starcie — odpowiedz na niego szczegółowo.

### Faza 2: Pattern Discovery (sesje 5-20)

Agent zaczyna:
- Rozpoznawać Twoje wzorce pracy (Model B)
- Gromadzić decyzje (Model C, low confidence)
- Budować bazę recall (journal → embeddings)

**Twoja rola:** Rejestruj decyzje. Taguj dobrze. Poproś o recall żeby sprawdzić.

### Faza 3: Confidence Building (sesje 20-50)

Agent:
- Model C ma 0.7+ confidence na typowych wzorcach
- Recall jest trafny (wystarczająco dużo wpisów w HNSW)
- Refleksje identyfikują realne trendy

**Twoja rola:** Testuj predykcje. Koryguj gdy się myli. Poproś o refleksje.

### Faza 4: Predictive & Reflective (sesje 50+)

Agent:
- Proaktywnie sugeruje (jeśli autonomy mode ≥ balanced)
- Blind spot detection wykrywa sprzeczności
- Self-modyfikacja staje się opcją

**Twoja rola:** Zaufaj sugestiom, ale weryfikuj. Pozwól na ewolucję.

### Faza 5: Meta-Cognitive (sesje 100+)

Agent:
- Weekly reflections identyfikują cross-pattern themes
- Patterns validated across weeks/months
- Trust rules auto-approve known-good actions
- Agent optymalizuje siebie

**Twoja rola:** Partnerska. Agent jest co-developer, nie tool.

---

## Podsumowanie

Memphis rośnie proporcjonalnie do tego, co w niego włożysz:

| Inwestycja | Zwrot |
|---|---|
| Podaj kontekst na starcie | Spersonalizowane odpowiedzi od razu |
| Rejestruj decyzje | Predykcje "co dalej" po 20+ decyzjach |
| Taguj wpisy | Trafny recall semantyczny |
| Poproś o refleksję | Identyfikacja blind spots i trendów |
| Pozwól na ewolucję | Agent rozszerza własne capabilities |

**Fundamentalna zasada:** Traktuj Memphis jak junior developera, którego mentorujesz. Im więcej mu wyjaśnisz **dlaczego** (nie tylko **co**), tym szybciej stanie się wartościowym partnerem.
