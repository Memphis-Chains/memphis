# USB Grabber Feed

Trwały feed video+audio z USB grabbera (MACROSILICON MS2109, /dev/video0) do aplikacji lokalnych przez PipeWire (Ripper USB 0/1) i opcjonalny podgląd okna SDL.

## Kontekst sprzętowy (VERIFIED 2026-09-12)

Memphis host ma **MACROSILICON MS2109** (USB ID `534d:2109`) — tani chipless grabber HDMI→USB, standard UVC.

- **/dev/video0** — Video Capture, MJPG max 1920x1080@60fps, YUYV dostępne
- **/dev/video1** — Metadata Capture
- **/dev/media0** — subdev API
- **ALSA hw:2,0** — MS2109 USB Audio (stereo, 48kHz)
- **v4l2loopback** — załadowany, tworzy /dev/video10 ("Ripper USB 0") i /dev/video11 ("Ripper USB 1")
- **PipeWire** — widzi 4 Video Sources: Ripper USB 0/1 (id 68/66) + USB Video bezpośrednio (id 76/93)
- **Telegram** — klient PipeWire (PID dynamic, app Telegram Desktop), może wybrać "Ripper USB 0" jako kamerę

## Wrappery w `~/.local/bin/`

- `memphis-probe` — szybka diagnostyka USB (JSON)
- `memphis-grabber-test` — defensive test 3s video+audio entropy
- `memphis-display` — wyświetl feed na ekranie lokalnym (okno SDL)
- `memphis-bridge` — feed z /dev/video0 → /dev/video10 (Ripper USB 0)

Wszystkie to symlinki do `/home/memphis/memphis/scripts/usb-*.{sh,py}`.

## Tier-0 procedura (bez sudo)

### 1. Diagnostyka stanu

```bash
memphis-probe
```

Output: JSON z `video_devices_count`, `v4l2_ffmpeg_sources`, `nvenc_status`, `obs_plugins`.

### 2. Test że feed działa

```bash
memphis-grabber-test
```

Output: JSON z verdict dla video (DYNAMIC/PARTIAL/STATIC) i audio (ACTIVE/QUIET/NOISE/SILENT).

### 3. Wyświetl feed lokalnie

```bash
memphis-display
```

Otwiera okno SDL z video (1280x720@30fps) + audio na głośnikach.

Zatrzymanie: Ctrl+C.

### 4. Sprawdź PipeWire

```bash
wpctl status
```

Powinno pokazać `Ripper USB 0` i `Ripper USB 1` jako Video Sources.

## Tier-1 procedura (sudo, jednorazowo)

### A. v4l2loopback autoload (po rebocie)

```bash
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
sudo tee /etc/modprobe.d/v4l2loopback.conf > /dev/null << 'EOF'
options v4l2loopback devices=2 video_nr=10,11 card_label="Ripper USB 0","Ripper USB 1" exclusive_caps=0,0
EOF
```

### B. Dodaj memphis do grup video + audio

```bash
sudo usermod -aG video,audio memphis
```

Po przelogowaniu ACL będzie widoczne w `getfacl /dev/video10`.

## Trwały feed (systemd user service)

### Tworzenie serwisu (tier-1, ale tylko zapis pliku w ~/.config — nie potrzebuje sudo do enable)

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/memphis-grabber-feed.service << 'EOF'
[Unit]
Description=Memphis USB Grabber Feed (video bridge to v4l2loopback)
After=default.target
Wants=memphis-warmup.service

[Service]
Type=simple
ExecStart=/home/memphis/.local/bin/memphis-bridge /dev/video0 /dev/video10 1280 720 30
Restart=always
RestartSec=5
WorkingDirectory=/home/memphis/memphis

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now memphis-grabber-feed.service
systemctl --user status memphis-grabber-feed.service
```

### Dzienny audyt (memphis_cron)

```bash
memphis_cron add grabber-feed-audit "0 6 * * *" 'bash /home/memphis/memphis/scripts/usb-grabber-test.py /dev/video0 2 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get(\"video\",{}).get(\"verdict\",\"?\"),d.get(\"audio\",{}).get(\"verdict\",\"?\"))" >> /home/memphis/.memphis/logs/grabber-feed-daily.log'
```

## Diagnostyka

### Typowe problemy

| Symptom | Cause | Fix |
|---|---|---|
| `v4l2loopback not loaded` | brak sudo modprobe | `sudo modprobe v4l2loopback devices=2 video_nr=10,11` |
| `/dev/video0 nie istnieje` | grabber nie podłączony | sprawdź USB, `lsusb \| grep 534d` |
| `Cannot open hw:2,0` | ALSA card inny | `arecord -l` → sprawdź card numer |
| Telegram nie widzi Ripper USB 0 | PipeWire nie zarejestrował | `wpctl status`, restart Telegram |
| Bridge wychodzi natychmiast | /dev/video0 znika (kabel) | sprawdź USB, restart service |
| Wiszący proces | ffmpeg segfault, USB reset | `pkill -f memphis-bridge && systemctl --user restart memphis-grabber-feed.service` |

## Anti-patterns

- ❌ Hardcoding USB device path /dev/video0 — use auto-detect (`memphis-bridge` does this)
- ❌ Running bridge as root — should run as `memphis` user (ACL via logind)
- ❌ Adding `obs-virtualcam` PPA on Ubuntu 25.10 — repo doesn't have it, use v4l2loopback path
- ❌ Polling v4l2-ctl in cron — use udev rules or systemd.path for hotplug
- ❌ Starting multiple bridge instances — only one can write to /dev/video10
- ❌ Using `--input_format mjpeg` on bridge — let auto-detect choose (default MJPG works)

## Reference

- `scripts/usb-virtualcam-bridge.sh` — bridge z auto-detect SRC
- `scripts/usb-grabber-display.sh` — display via gst-launch
- `scripts/usb-grabber-test.py` — entropy analysis
- `scripts/usb-capture-probe.sh` — JSON USB diagnostics

## Workflow

### 1. Diagnose current state

- Run `memphis-probe` to get JSON snapshot
- Check `lsmod | grep v4l2loopback` to verify module state
- Check `lsusb | grep 534d` to verify grabber attached
- Check `wpctl status` to verify PipeWire sees sources

### 2. Bootstrap if needed (tier-1, sudo)

- Apply `/etc/modules-load.d/v4l2loopback.conf`
- Apply `/etc/modprobe.d/v4l2loopback.conf`
- `sudo usermod -aG video,audio memphis`

### 3. Install systemd service

- Create `~/.config/systemd/user/memphis-grabber-feed.service`
- Enable and start with `systemctl --user enable --now`
- Verify with `systemctl --user status`

### 4. Verify feed

- Run `memphis-grabber-test` — should show DYNAMIC video + ACTIVE_SIGNAL audio
- Run `memphis-display` — should show live feed in window
- Open Telegram → Settings → Devices → verify "Ripper USB 0" listed

### 5. Commit and document

- All scripts are tier-0 and idempotent
- No drive-by changes outside the skill scope

## Reference memories

- Decision tui-1789239620999 (USB capture stack)
- Decision tui-1789240746667 (Telegram USB ripper plan)
- Decision tui-1789241403092 (anti-confab format fix)
- Journal 416-422 (sessions 2026-09-12)
