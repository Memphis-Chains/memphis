# Priorytety — tydzień 2026-09-29 (auto, generowane z realnego stanu)

Źródło: `cron tuesday-code.sh` · issue 36 otwartych · PR 3 · gałęzię 4

> Ten plik jest źródłem prawdy dla sesji kodowania. Każdy poniedziałek jest
> nadpisywany. Nie edytuj ręcznie — zmieni się przy następnym uruchomieniu.

## A. Do zrobienia TERAZ (bez pytania, odwracalne)

- [ ] Zamknąć issue z fixem już w main (patrz sekcja B)
- [ ] Przejrzeć PR-y czekające na review (sekcja C)
- [ ] Podjąć decyzję o gałęziach z konfliktami (sekcja D)

## B. Issue OTWARTE, ale fix JUŻ JEST w main — do zamknięcia

- [ ] **#62** [MED] CLI has no centralized command registry with lazy loading
- [ ] **#57** [MED] No automatic learning extraction or self-reflection loop
- [ ] **#56** [MED] Skills system underutilized — no skill marketplace or creator
- [ ] **#50** Phase 5: Skill Engine — skill DSL, AI composer, self-modification, workf
- [ ] **#48** Phase 3: Network + Security — nmap, tcpdump, Vault, Prometheus, DNS, pro
- [ ] **#47** Phase 2: Cloud + IaC — AWS SDK, GCP, Azure, Terraform, Ansible, Kubernet
- [ ] **#44** MAXIMUM-TOOLKIT: Research — 500+ tools across 12 categories for self-evo

  *Dowód (commit na origin/main):*
  - #62: `fix(embed): atomic reindex write — issue #628 (#631)`
  - #57: `fix(codex-round): both P2 findings from #579 + #580 — bundled (#583)`
  - #56: `feat(kartograf): v4 training stack — env-driven DeBERTa-v3-large alter`
  - #50: `feat(cli): Phase 3.1 — memphis demo arm/status/disarm (#507)`
  - #48: `feat(anti-confab): runtime audit — log forbidden claims with tool-call`
  - #47: `feat(anti-confab): search-claim guard — bot must call read tool before`
  - #44: `feat(tools): fill helpText + cliFlags for 5 more tier-2 tools (Sprint `

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

- **6×** `ci`
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

