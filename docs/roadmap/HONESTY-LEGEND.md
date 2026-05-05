# Honesty Legend

> **Cel:** strona publiczna Memphis (memphis-v5.pl/roadmap) używa znaczników statusu, żeby operator/inwestor/grant-reviewer od razu wiedział co jest **żywe**, co jest **w drodze**, a co jest **research-side**.

Bez tej legendy łatwo o nieporozumienie: "fajnie, LeWorldModel działa" — gdy LeWM jest tylko spec'em w `docs/dev/`. Tu pinujemy znaczenie każdego symbolu.

## Statusy

| Symbol | Znaczy | Kryterium minimum |
|---|---|---|
| ✅ | **shipped** | Kod żyje na `main`, operator może odpalić DZIŚ jednym konkretnym poleceniem CLI/TUI/HTTP. PR ID lub commit hash. Test coverage ≥ baseline. |
| ⏳ | **in-progress** | Kod istnieje, ale niepełny: brak jednej warstwy (np. CLI ready, NAPI not yet) albo nie zmergowane na `main`. Branch identifiable. |
| 🔬 | **spec** | Zatwierdzona specyfikacja w `docs/dev/` lub `docs/roadmap/`. Brak kodu. Estymata czasu + zależności. |
| 📐 | **design** | Wczesny koncept, hipoteza. Brak spec'a. Może się zmienić znacząco. Discussion-stage. |
| ⚠️ | **deferred** | Świadomie pominięte z aktualnego scope'u (Y1 / Y2). Nie jest porzucone — nie jest planowane teraz. |
| 🤝 | **collab-needed** | Wymaga decyzji operatora, partnera zewnętrznego, lub budżetu cloud. Nie zacznie się bez sygnału. |

## Reguły dla autora roadmapy

1. **Każdy punkt MUSI mieć evidence-anchor.**
   - ✅ → PR # albo path do działającego pliku
   - ⏳ → branch name + co jeszcze brakuje
   - 🔬 → path do spec'a (`docs/dev/X.md`)
   - 📐 → discussion thread / brainstorm note
   - ⚠️ → uzasadnienie pominięcia (Y1 v3.1 reguła X / Wodzu deferred / blocked-on-Y)

2. **Nie awansuj statusu bez kotwicy.**
   - Specyfikacja nie czyni feature'a `⏳`. Dopiero pierwszy commit.
   - Pierwszy commit nie czyni feature'a `✅`. Dopiero CLI/HTTP/TUI surface dla operatora.

3. **Degradacja jest OK.**
   - Jeśli feature się rozjedzie / breakuje — degradujemy z `✅` do `⏳` (z notatką "regression od v1.X.Y").
   - Operator widzi prawdę, nie historyczną deklarację.

4. **Lata = predykcja, nie zobowiązanie.**
   - "2027 Q2" nie znaczy "obiecujemy do końca Q2 2027".
   - Znaczy: "wedle obecnej wiedzy, najprawdopodobniej w tym oknie". Może się zmienić.
   - Predykcje na Y2+ świadomie szersze (Q1-Q2, Q2-Q3) — dystans tłumaczy nieostrość.

5. **AGI nie pojawia się na liście.**
   - Memphis nie obiecuje AGI.
   - Memphis dostarcza **suwerennego asystenta z lokalną pamięcią + audytem + opcjonalną federacją**. Tyle.
   - Każde użycie słowa "AGI" w roadmapie = automatyczny czerwony flag.

## Reguły dla operatora czytającego stronę

1. **`✅` = możesz uruchomić TERAZ.** Klikalna komenda CLI / TUI gesture.
2. **`⏳` = możesz uruchomić, ale nie polegaj na tym jako produkcji.** Często development branch.
3. **`🔬` lub niżej = przyszłość, nie teraz.** Nie planuj workflow'u na to.
4. **Jeśli punkt nie ma evidence-anchor — to bug w roadmapie, nie feature w produkcie.** Zgłoś.

## Cross-references

- Pełna roadmap: `ROADMAP_2026_2030.md` (ten sam katalog)
- Często-zadawane pytania: `PUBLIC_FAQ.md` (ten sam katalog)
- Lista wewnętrznych decyzji + sprintów: `docs/roadmap/Y1-2026-05-to-2027-05.md`

---

*Memphis filozofia: znacznik mówi prawdę, kod ją potwierdza, dane operatora o tym świadczą. Wszystko mniejsze to marketing.*
