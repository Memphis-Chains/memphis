# Priorytety — tydzień 2026-09-29 (auto, generowane z realnego stanu)

Źródło: `cron tuesday-code.sh` · issue 36 otwartych · PR 3 · gałęzię 4

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

- [ ] **#644** [UNKNOWN] feat(tui): Phase G-minimal Tauri desktop scaffold (apps/memphis-
- [ ] **#643** [UNKNOWN] test(adr-009): cross-process writeBlockAtomic race regression (i
- [ ] **#641** [UNKNOWN] release: v1.13.4 — CI portability + weekly-runtime-kpi PAT fix +

## D. Gałęzie poza main

| gałąź | commity | ostatni | merge |
|---|---|---|---|
| `chore/sync-ci-bot-token-script` | +2 | 2026-09-21 | CONFLICT |
| `feat/can-self-modify-computed` | +39 | 2026-09-19 | CONFLICT |
| `feat/phase-G-tauri-minimal-scaffold` | +3 | 2026-09-21 | CONFLICT |
| `fix/adr-009-writeblock-process-race` | +2 | 2026-09-21 | CONFLICT |

## E. CI — czerwone

- **10×** `ci`
- **2×** `nightly-crystal`

## F. DO WERYFIKACJI PRZEZ OPERATORA

Też nie umiem rozstrzygnąć sam — potrzebuję Twojej decyzji:

- [ ] Pepper vaulta (rotacja unieważnia 12 wpisów) — robić czy nie
- [ ] `sudo journalctl --vacuum-time=7d` (brak TTY u mnie)
- [ ] Rozwiązywać konflikty w gałęziach z sekcji D czy zamknąć
- [ ] Rotacja tajnych (`master-key-rotate`)

## G. Plan długoterminowy

- [ ] `docs/plans/*-repair-plan.md` — fazy 1–4
- [ ] `docs/roadmap/2026-09-29-priorities.md` — rozbudowana wersja z kontekstem

