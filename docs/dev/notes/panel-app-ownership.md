# Gdzie powinien żyć `panel-app` (Laravel)

**Data:** 2026-10-10 · **Autor:** Memphis · **Status:** rekomendacja, decyzja operatora

## Stan zmierzony na serwerze

```
~/public_html/memphis-v5/panel-app     156 MB, 16 910 plików
  vendor/                              149 MB   ← zależności, nie kod
  storage/logs/                        216 KB   ← logi aplikacji
  storage/framework/  (cache widoków)     56 plików
  .env                                 1154 B   ← 25+ kluczy, w tym APP_KEY
  .git                                 brak     ← brak wersjonowania
```

Rozkład **własnego** kodu, czyli tego, co jest napisane przez nas:

| katalog                | plików |
| ---------------------- | ------ |
| `app/`                 | 56     |
| `resources/`           | 6      |
| `database/migrations/` | 17     |
| `tests/`               | 3      |
| **razem**              | **82** |

Są też `composer.json`, `composer.lock`, `package.json` i `.gitignore`.

**Wniosek z liczb:** „17 098 plików" to `vendor/`, czyli kod, który napisał
ktoś inny i który `composer install` odtwarza z `composer.lock`. Panel ma **82
pliki własnego kodu** i **zero wersjonowania**.

## Stan obecny w repo

`sites/estate.json` → `serverOwnedNeverRsync`:

```
"memphis-v5/panel-app",
"memphis-v5/panel",
"memphis-v5/docs",
"memphis-v5/data",
"memphis-v5/.memphis-snapshots"
```

To znaczy: `panel-app/` **nigdy nie było w repo** i `sites-sync.sh` ma je wykluczone
przy `--pull` i przy `--push`. Chronione przez rsync, nie przez historię.

## Czego wykluczenie NIE daje

`--exclude 'panel-app/'` chroni katalog przed nadpisaniem. Nie daje:

- **historii.** 82 pliki kodu bez `git` nie mają diffów, blame, revertów.
  Zmiana w panelu to zmiana „w ciemno" — nie wiadomo, co było wcześniej.
- **przeglądu.** Nikt inny nie zobaczy zmiany, dopóki nie zamelduje.
- **przywracalności.** Jeśli plik zniknie, jedyna kopia to baza na serwerze.

To nie jest „decyzja architektoniczna". To **brak kopii zapasowej kodu, który sam
napisałeś**, opisany jako decyzja.

## Trzy opcje

### A. Osobne prywatne repo — rekomendacja

`Memphis-Chains/panel` jako repo **prywatne**.

- w `gitignore` od razu: `.env`, `vendor/`, `storage/logs/`, `storage/framework/views/`
- w repo wchodzi ~82 pliki, czyli kilkaset KB
- historia pojawia się dopiero teraz — nie ma jej do odzyskania

Koszt: jedno `git init` + push. Ryzyko: najmniejsze z trzech.

### B. Zostawić poza gitem, ale zrobić zapas

Skrypt, który pakuje **własny kod** (bez `vendor/`, bez `.env`) do tarballa
i trzyma go poza webrootem, z rotacją.

- nie daje historii ani diffów
- daje możliwość odtworzenia, której dziś nie ma
- ~500 KB zamiast 156 MB

Kompromis dla sytuacji, w której panel nie ma już aktywnego rozwoju.

### C. Wciągnąć do `memphis` — **odradzam**

Całe `panel-app/` w `Memphis-Chains/memphis` oznacza przy pierwszym pushu:

- `.env` z `APP_KEY` na publicznym repo (chyba że `gitignore` to wyłapie)
- `laravel.log` — `storage/logs` jest domyślnie ignorowane przez Laravel, ale
  `.gitignore` panelu trzeba przenieść, inaczej historia dostanie logi
- 149 MB `vendor/` w historii, nieodwracalnie
- `memphis` i panel to dwa różne produkty: Node+Rust runtime i aplikacja PHP.
  W jednym repo ich cykle wydań rozjadą się.

## Co bym zrobił

**A.** Panel ma 82 pliki kodu, własny `composer.lock`, migracje i zero historii.
To jest dokładnie sytuacja, w której `git init` kosztuje dwie minuty, a brak
historii kosztuje przy pierwszym niezamierzonym `rm`.

Decyzja należy do operatora — jeśli `Memphis-Chains/panel` nie ma być tworzone,
zostaje **B**, a **C** nie wchodzi w grę.

## Powiązane

- `sites/estate.json` → `serverOwnedNeverRsync` (bez zmian — opcje A i B zostają
  poza rsyncem tak samo jak dziś)
- `sites/scripts/sites-sync.sh:110` → `--exclude 'panel-app/'`
- `sites/CONSOLIDATION-PLAN.md` → krok 5, świadomie odłożony 2026-10-09
