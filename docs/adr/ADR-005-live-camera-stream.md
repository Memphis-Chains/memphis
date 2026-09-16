# ADR-005 — Live camera stream z USB grabber na shared hosting (lessons learned)

**Status:** proposed 2026-09-13 (po sesji marcin-kukla.pl/live end-to-end)
**Decydent:** Wodzu (operator)
**Kontext:** Pipeline camera → marcin-kukla.pl/live działał 90 minut (live zweryfikowane end-to-end: 26/26 LIVE ramek w ostatnich 60s, 3 różne md5 w curl), a potem świadomie zrollbackowany (privacy — kamera tylko dla operatora, nie publicznie).

## Decyzja

**Nie deployować** `marcin-kukla.pl/live` publicznie w obecnej formie. **Dopuszczalne** jest:
- lokalny preview VLC (ten komputer, dla operatora) ✓
- zapis nagrań do vault (offline, po sesji) ✓
- udostępnienie po auth (token, IP allow-list) — do przemyślenia

## Co zrobiliśmy (archiwum sesji 2026-09-12/13)

### Pipeline
```
/dev/video1 (MS2109 grabber, 1280x720@30fps MJPEG)
  → ffmpeg -f v4l2 -input_format mjpeg → image2pipe (ciągły)
  → mkfifo /tmp/memphis-live-pipe.bin
  → Python consumer (parsuje JPEG po markerach FFD8/FFD9)
  → bash upload loop (co 2s) → SSH cat > ~/public_html/marcin-kukla/live/stream.jpg
  → HTTP https://marcin-kukla.pl/live/ (JS polling co 2s, cache-bust ?v=N)
```

### Pliki (commit `1700403` + `ed7a045`)
- `scripts/live/index.html` — strona live z JS polling
- `scripts/live/memphis-camera-publish-live.sh` — capture+upload loop
- `scripts/live/memphis-camera-publish-live.service` — systemd template

### Server-side modyfikacje (rollback wykonany)
- `public_html/marcin-kukla/live/` — katalog
- `public_html/marcin-kukla/index.html` — link "live" w nav
- `public_html/marcin-kukla/sitemap.xml` — 2 wpisy
- `public_html/marcin-kukla/agents.json` — wpis `live_stream`

## Lessons learned (konkretne, ranking po impact)

### 1. **MS2109 grabber wymaga 1-15s handshake po ffmpeg open** (CRITICAL)
- Objaw: `-frames:v 1` co 2s = non-stop handshake = ciągle czarny ekran
- Dowód: 2-min direct capture (t=1s BLACK, t=10-110s WSZYSTKIE LIVE)
- Fix: trzymaj ffmpeg otwarty (image2pipe + FIFO + ciągły consumer)
- **Lekcja na przyszłość:** każdy UVC grabber może mieć inny czas handshake. Przed deployem zrób 5-min direct capture i zweryfikuj pattern.

### 2. **scp z `ssh -F config` nie działa z port 40022 + IdentityFile** (HIGH)
- `scp -F config lhpl:/foo /bar` zwraca `Permission denied`
- Fix: `cat jpg | ssh -F config lhpl "cat > /path"` (atomic stdin)
- **Lekcja:** LH.pl SSH wymaga tej ścieżki. Alternatywy: rsync przez SSH też mają podobne problemy.

### 3. **SSH cold connect do LH.pl = 67s** (HIGH)
- Bez `ConnectTimeout` w configu publisher wisi na pierwszym SSH (mkdir)
- Fix: dodałem `ConnectTimeout 10 ServerAliveInterval 30 ServerAliveCountMax 2` do `~/.ssh/lhpl-active/config`
- **Lekcja:** LH.pl ma rate limiting na SSH. Pierwsze połączenie po idle jest wolne. Zawsze ustawiaj ConnectTimeout.

### 4. **image2pipe nie pisze do zwykłego pliku** (MEDIUM)
- `ffmpeg ... -f image2pipe -vcodec mjpeg /tmp/pipe.bin` zwraca "Immediate exit requested"
- Fix: `mkfifo /tmp/memphis-live-pipe.bin` (named pipe / FIFO)
- **Lekcja:** image2pipe wymaga stream-oriented output. Plik zwykły nie działa, named pipe (FIFO) działa.

### 5. **xfwm4 composite + xfce4-screensaver idle-cover** (MEDIUM, dla preview)
- idle-cover 1680×1050 przezroczysta warstwa przykrywa preview po ~2 min bezczynności
- VLC `--video-on-top` nie chroni przed idle-cover
- **Lekcja na przyszłość:** przed demonstracjami wyłącz xfce4-screensaver przez `xset s off -dpms` + `pkill xfce4-screensaver`

### 6. **VLC Qt interface > gstreamer xvimagesink** (MEDIUM, dla preview)
- `xvimagesink` overlay nie pojawia się w `xwininfo` w XFCE4 z composite
- `gtksink` wymaga GTK widget z CLI nie dostępny
- VLC `--intf=qt v4l2:///dev/videoX` tworzy prawdziwe WM-managed okno
- **Lekcja:** przy "pokaż obraz z kamery na X11" → VLC > gst-launch.

### 7. **shell tool closure zabija `nohup &` background** (LOW)
- `nohup ffmpeg ... &` w exec shell ginie wraz z parent shell po ~30s
- Fix: `systemd-run --user --unit=NAME --slice=user.slice /skrypt.sh`
- **Lekcja:** do długotrwałych daemonów w shell tools używaj systemd-run, nie &.

## Co zrobić NASTĘPNYM razem, jeśli znów będzie potrzebny live

### Architektura v2 (production-grade)
1. **Serwer z nginx-rtmp** lub własny VPS z HLS — lepsze niż polling JPEG
2. **TLS + auth** (Cloudflare Access lub Basic Auth)
3. **Rate limit** (max 1 req/sec per IP)
4. **Persistent systemd** (nie transient): `systemctl --user enable memphis-camera-publish-live.service`
5. **Watchdog** co 60s — jeśli publisher umarł, restart
6. **Dysk monitoring** (300KB/2s = 13GB/dzień, LH.pl dysk 143G → ~10 dni)
7. **Audit log** w chain (każdy start/stop/restart jako journal block)

### Koszt vs wartość
- LH.pl polling JPEG: prosta infra (shared Apache), ale jakość "live" jest niska (2s refresh, JPEG artifacts)
- nginx-rtmp HLS: potrzebuje VPS (np. Hetzner €4/mies), 5x lepsza jakość
- WebRTC: najlepsza jakość, ale wymaga TURN server

**Rekomendacja:** jeśli kiedykolwiek publiczny live wraca — wynajmij Hetzner CX22 (€4/mies) + nginx-rtmp + Cloudflare stream. LH.pl polling JPEG to było "good enough for test, not for production".

## Dlaczego wycofaliśmy
- Prywatność: obraz z kamery na publicznej stronie bez auth = każdy kto zna URL widzi
- Brak NDA/RODO review dla live stream z prywatnego komputera
- Łatwe do odwrócenia — nie ma powodu trzymać publicznego endpointu

## ANTI-CONFAB phase 6
- VERIFIED: 26/26 LIVE ramek w sesji testowej, 3 różne md5 w curl, rollback czysty (404 na /live, oryginalne sitemap/agents, working tree clean)
- UNVERIFIED: czy LH.pl nie cache'uje robots/sitemap/agents — sprawdzone curl HEAD na /live/ (404 natychmiast)
- OUT OF SCOPE: Hetzner/nginx-rtmp plan, Cloudflare Access setup, NDA/RODO review

## Referencje
- decision tui-1789251089194 (live deploy)
- decision tui-1789253146892 (debug + handshake fix)
- journal #429, #430
- commits 1700403, ed7a045
