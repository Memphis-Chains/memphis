# Skill: play-customer-promo-video

**Tier:** 0 (read + exec user-level)
**Wersja:** v1.1 (2026-09-17)

## Cel

Ściągnij i odpal wideo/audio/image hostowane na stronie klienta, lokalnie w X11.

## Kiedy używać

- Operator: "odpal to wideo z <URL>"
- Operator: "pobierz + sprawdź <asset>"

## Wymagania

`DISPLAY=:0` (X11 lokalne), `~/.Xauthority`, player: **mpv** (preferowany) → **vlc** → **ffplay** → **parole**.
Narzędzia: `curl`, `ffprobe`, `file`, `head`, `xdpyinfo`.

## Kroki

1. **Fetch + identyfikacja assets:**
   ```bash
   curl -sSL <url> | grep -oE '(src|href)="[^"]+\.(mp4|webm|mov|jpg|png|mp3)"'
   ```

2. **Pobierz + walidacja HTTP:**
   ```bash
   curl -sSL -o asset.mp4 "<url>" -w "HTTP %{http_code} size=%{size_download} type=%{content_type}\n"
   ```

3. **Walidacja pliku:** `./verify.sh asset.mp4` — 7 testów (rozmiar, magic bytes, ffprobe, X11, player, readable).

4. **Odpal w tle:** `./play.sh asset.mp4` — auto-detect player, `setsid -f` (detached), log `/tmp/<player>-skill-<pid>.log`.

5. **Potwierdź:** `pgrep -f <player>` → PID. Brak po 3s? → `cat /tmp/<player>-skill-*.log`.

## Granice (czego NIE robi)

- Nie pobiera z auth/CDN (wymaga token)
- Nie obsługuje HLS/DASH (`.m3u8`, `.mpd`)
- Nie uploaduje, nie transkoduje
- Nie dotyka sudo/services/boot

## Pliki

- `SKILL.md` — ten dokument
- `play.sh` — odpal w tle
- `verify.sh` — 7 testów walidacji

## Ewolucja

Po każdym użyciu jeśli widzisz co do poprawy:
1. Przygotuj **diff do plików** (jedno zdanie co i dlaczego)
2. **Wstrzymaj się** — pokaż operatorowi
3. Po "go" → `memphis_self_modify` z patchem + bump wersja w nagłówku
4. Notatka co i dlaczego zmieniono w `decisions` chain

## Lessons learned (z ostatniej sesji 2026-09-17)

- **Runtime quirk:** ścieżki `~/...` działają w `memphis_exec`, `/home/<user>/...` (absolute) czasem zwraca "No such file". **Zawsze `cd $(dirname)` przed `setsid`.**
- **Runtime quirk:** shell to `/bin/sh` (nie bash), pipefail-style. **Nie oceniaj sukcesu po `$?` exec — sprawdzaj `ps`/`pgrep`.**
- **Player hierarchy:** mpv > vlc > ffplay > parole. mpv nie jest zainstalowany na tym systemie (rekomendacja dla przyszłości).
- **Anti-pattern:** `nohup cmd &` z parent shell umiera razem z exec. **`setsid -f cmd` (z `</dev/null`) = detach prawidłowy.**
- **verify.sh v1.0 → v1.1:** TEST 4 miał false-positive dla JPEG (ffprobe raportował "video stream" dla statycznych obrazów). **Fix:** rozróżnij kind (mp4/mkv/jpg) przed sprawdzaniem stream types.
