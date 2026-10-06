# Priorytety — tydzień 2026-10-06 (auto, generowane z realnego stanu)

Źródło: `cron tuesday-code.sh` · issue 36 otwartych · PR 0 · gałęzię 5

> **Ten plik jest źródłem prawdy dla sesji kodowania.** Generowany wtorek 13:00
> z realnego stanu (issue, PR, gałęzie, CI). Nie edytuj ręcznie.
>
> **ZASADA SESJI KODOWANIA:** pierwszy krok = przeczytaj `docs/roadmap/current-priorities.md`.
> Zrób pozycje z A i B. Zatrzymaj się na F — decyzje operatora, nie zgaduj.
> Po zrobieniu: odznacz checkbox, dopisz co zrobiłeś pod daną pozycją.

## A. Do zrobienia TERAZ (bez pytania, odwracalne)

- [ ] Zamknąć issue z fixem już w main (patrz sekcja B)
- [ ] Przejrzeć PR-y czekające na review (sekcja C)
- [ ] Podjąć decyzję o gałęziach z konfliktami (sekcja D)

## B. Issue otwarte, ale fix już w main

Brak — albo wszystko zrobione, albo fixy nie mają `#NNN` w commicie.

## C. PR do review

Brak otwartych PR.

## D. Gałęzie poza main

| gałąź | commity | ostatni | stan |
|---|---|---|---|
| `fix/minimax-m3-family-capabilities` | +1 | 2026-10-01 | MERGEABLE |
| `fix/persist-reply-limit-4000` | +1 | 2026-10-01 | MERGEABLE |
| `fix/provider-credential-state-and-tui-error-log` | +1 | 2026-10-01 | MERGEABLE |
| `fix/soul-write-clobber` | +4 | 2026-09-30 | CONFLICT x1 → crates/memphis-operator/src/chat.rs |
| `fix/tui-worker-panic-surfacing` | +1 | 2026-10-01 | MERGEABLE |

## E. CI — czerwone

- **3×** `ci`
- **1×** `nightly-crystal`

## F. DO WERYFIKACJI PRZEZ OPERATORA

Też nie umiem rozstrzygnąć sam — potrzebuję Twojej decyzji:

- [ ] Pepper vaulta (rotacja unieważnia 12 wpisów) — robić czy nie
- [ ] `sudo journalctl --vacuum-time=7d` (brak TTY u mnie)
- [ ] Rozwiązywać konflikty w gałęziach z sekcji D czy zamknąć
- [ ] Rotacja tajnych (`master-key-rotate`)

## G. Plan długoterminowy

- [ ] `docs/plans/*-repair-plan.md` — fazy 1–4
- [ ] `docs/roadmap/2026-09-29-priorities.md` — rozbudowana wersja z kontekstem

