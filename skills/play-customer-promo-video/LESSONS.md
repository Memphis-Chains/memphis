# Lessons learned — play-customer-promo-video

Ten plik jest append-only. Każdy wpis = jedno użycie skilla + obserwacje + propozycje zmian.
Format:

```
## YYYY-MM-DD — <kontekst jednym zdaniem>

**VERIFIED:**
- ...

**UNVERIFIED / OPEN:**
- ...

**PROPOZYCJA ZMIANY W SKILLU:**
- ...

**STATUS:** ⏳ czeka na akceptację operatora | ✅ zaakceptowane i wdrożone | ❌ odrzucone
```

---

## 2026-09-17 — dsmx-usa-promo-30s-canam-polaris.mp4 (DS MX USA promo)

**Kontekst:** Operator poprosił o ściągnięcie + odpalenie wideo z `https://dsmxshop.com/usa`. Plik 3.7 MB, h264 1280x720, AAC audio, 30s.

**VERIFIED:**
- Strona używa HTML5 `<video controls>` z `<source>` wskazującym na `assets/dsmx-usa-promo-30s-canam-polaris.mp4`. Prosty, jeden plik, brak DRM/streamingu.
- `curl -sSL` z `content-type: video/mp4` i `size_download: 3859857` = prawidłowe pobranie.
- `ffprobe` potwierdza: ISO BMFF v1, h264 video 1280x720, AAC audio, duration 30.000s.
- `vlc --play-and-exit --no-loop` w tle (`setsid -f`) startuje, odtwarza 30s, sam się zamyka.
- NVIDIA VDPAU aktywna w logu VLC → hardware decode działa.

**UNVERIFIED / OPEN:**
- Czy mpv jest lepszy niż VLC dla długich sesji (nie testowane — nie mam mpv).
- Czy plakat JPG (`dsmx-usa-promo-30s-poster.jpg`) też trzeba pobierać (zrobione, ale nieodtwarzane — używany tylko jako preview).

**PROPOZYCJA ZMIANY W SKILLU (v1.0 → v1.1):**

1. **Runtime quirk: ścieżki ~/... vs /home/...** — runtime w `memphis_exec` widzi pliki przez `~`-expansion, ale `ls /home/<user>/...` (absolute path) czasem zwraca "No such file". Skille MUSZĄ używać `~` albo `cd $(dirname)` przed odpaleniem — inaczej player zgłasza brak pliku mimo że curl go ściągnął. Już wdrożone w v1.0 (`play.sh` robi `cd` przed `setsid`).

2. **Runtime quirk: shell to /bin/sh, nie bash** — `nohup vlc ... &` z backgroundingiem działa ale exec ma często exit 1 bo ostatnia komenda w pipeline zwraca 1. **Wniosek: sprawdzaj realny stan (`ps`, `pgrep`), nie exit code exec.** Już wdrożone w v1.0 (`pgrep -f` zamiast `$?`).

3. **Dodaj `--intf qt` fallback detection** — gdyby `vlc` bez GUI zjadł środowisko (np. brak `DISPLAY`), skill powinien od razu wybrać `cvlc` albo `ffplay -nodisp`. **Do zrobienia w v1.1** jeśli kiedyś to wybuchnie.

4. **verify.sh: dodaj test na runtime quirk** — `stat "$FILE"` + `head -c 4 "$FILE"` zamiast jednego, żeby złapać przypadek gdy plik "istnieje" ale nie jest czytelny. Już wdrożone częściowo (TEST 7) — można rozbudować.

5. **Brak `mpv` na systemie** — w v1.0 preferuję mpv ale go nie ma, więc fallbackuje na vlc. **Rekomendacja: operator zainstaluje `mpv` aptem jeśli chce lżejszą ścieżkę.** Nie zrobiłem bez pytania (tier-1, install bez wyraźnego "go" = over-reach).

6. **Anti-pattern do unikania: odpalenie playera i natychmiastowe exec close** — pierwszy raz tak zrobiłem i player został sierotą (przypisany do nieistniejącego już shella). `setsid -f` + `</dev/null` to właściwy wzorzec. Już wdrożone w v1.0.

7. **Nie polegaj na `which nohup` / `command -v nohup`** jeśli możesz — `setsid` jest lepszy (gwarantuje detach od controlling terminal). Już wdrożone w v1.0.

**STATUS:** ⏳ czeka na akceptację operatora (diff do `play.sh` + `verify.sh` + ten plik)
