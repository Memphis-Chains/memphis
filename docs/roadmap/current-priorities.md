# Priorytety — tydzień 2026-10-13 (auto, generowane z realnego stanu)

Źródło: `cron tuesday-code.sh` · issue 36 otwartych · PR 0 · gałęzię 17

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
| `chore/final-metrics` | +1 | 2026-10-11 | CONFLICT x1 → sites/memphis-v5/index.html |
| `chore/final-metrics-2` | +1 | 2026-10-11 | CONFLICT x1 → sites/memphis-v5/index.html |
| `chore/site-metrics-sync` | +1 | 2026-10-12 | MERGEABLE |
| `ci/automerge-ruleset-and-notes` | +2 | 2026-10-10 | CONFLICT x3 → .github/workflows/automerge.yml, tests/ops/automerge-decision-contract.test.ts |
| `docs/handoff-2026-10-10` | +4 | 2026-10-10 | CONFLICT x4 → .github/workflows/automerge.yml, .gitignore |
| `fix/automerge-second-trigger` | +1 | 2026-10-10 | CONFLICT x3 → .github/workflows/automerge.yml, tests/ops/automerge-decision-contract.test.ts |
| `fix/backup-exclusions-and-atomic-publish` | +21 | 2026-10-12 | CONFLICT x2 → scripts/scheduled-backup-runner.mjs |
| `fix/minimax-m3-family-capabilities` | +1 | 2026-10-01 | MERGEABLE |
| `fix/nightly-backup-unit` | +2 | 2026-10-12 | MERGEABLE |
| `fix/persist-reply-limit-4000` | +1 | 2026-10-01 | MERGEABLE |
| `fix/provider-credential-state-and-tui-error-log` | +1 | 2026-10-01 | MERGEABLE |
| `fix/soul-write-clobber` | +4 | 2026-09-30 | CONFLICT x1 → crates/memphis-operator/src/chat.rs |
| `fix/tui-worker-panic-surfacing` | +1 | 2026-10-01 | MERGEABLE |
| `fix/usb-offsite-backup` | +3 | 2026-10-12 | MERGEABLE |
| `update/675` | +4 | 2026-10-11 | MERGEABLE |
| `verify/automerge-probe` | +2 | 2026-10-10 | CONFLICT x2 → .github/workflows/automerge.yml |
| `verify/cron-single` | +4 | 2026-10-11 | MERGEABLE |

## E. CI — czerwone

- **2×** `Telegram smoke test`
- **2×** `ci`

## F. DO WERYFIKACJI PRZEZ OPERATORA

Też nie umiem rozstrzygnąć sam — potrzebuję Twojej decyzji:

- [ ] Pepper vaulta (rotacja unieważnia 12 wpisów) — robić czy nie
- [ ] `sudo journalctl --vacuum-time=7d` (brak TTY u mnie)
- [ ] Rozwiązywać konflikty w gałęziach z sekcji D czy zamknąć
- [ ] Rotacja tajnych (`master-key-rotate`)

## G. Plan długoterminowy

- [ ] `docs/plans/*-repair-plan.md` — fazy 1–4
- [ ] `docs/roadmap/2026-09-29-priorities.md` — rozbudowana wersja z kontekstem

