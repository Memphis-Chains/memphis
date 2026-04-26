# Voice setup — operator runbook

Memphis voice features (Whisper STT + MMS-TTS-Pol or Google TTS) are
opt-in. This page covers what to install, what to configure, and how
to validate end-to-end before relying on it for daily use.

## Prerequisites

`scripts/install-prerequisites.sh` (Phase F, v1.7.1) auto-installs:

- `ffmpeg` — audio transcode pipeline; Whisper input goes through it
- `libasound2-dev` (Debian/Ubuntu) / `alsa-lib-devel` (Fedora/RHEL) —
  ALSA headers for mic-capture support

If you skipped that script and ran `scripts/install.sh` standalone,
re-run prereqs:

```bash
bash scripts/install-prerequisites.sh
```

To verify:

```bash
ffmpeg -version | head -1   # any 4.x or newer
ldconfig -p | grep libasound  # libasound.so* must show up
```

## Configuration

Voice needs an inference provider. Two choices today:

- **HuggingFace** (default; free quota, supports Polish via MMS-TTS-Pol):

  ```bash
  memphis vault add --key huggingface_api_token   # paste your HF token
  ```

  This auto-sets `HUGGINGFACE_API_TOKEN` in `.env` (vault-ref pattern;
  the daemon resolves on each request).

- **Google TTS** (commercial; better natural prosody but $$):

  ```bash
  memphis vault add --key google_tts_api_key
  ```

After either, restart the daemon (or use `memphis tools list` to see
what's reachable):

```bash
systemctl --user restart memphis     # if running as a unit
# or, in TUI: /reload
```

## Enabling voice in chat

Per surface:

- **TUI**: `/voice on` → toggles voice replies for the active session.
  `/voice status` shows current quota + provider.
- **Telegram**: `/voice on` (DM the bot from an allow-listed user).

Quota defaults: 100 voice replies per chat per day. Override with
`MEMPHIS_VOICE_DAILY_LIMIT` in `.env`.

## Validation flow

1. `bash scripts/install-prerequisites.sh` — installs ffmpeg + ALSA
2. `memphis vault add --key huggingface_api_token` — supply HF token
3. Restart daemon: `systemctl --user restart memphis`
4. Open TUI: `memphis tui`
5. `/voice on`
6. Send a chat message — expect text reply AND audio playback in TUI
   (or .ogg attachment in Telegram)

If step 6 fails:

- `/voice status` reports the actual quota state + provider config
- daemon logs at `~/.memphis/logs/memphis.log` carry the upstream
  HF/Google error
- `ffmpeg -i /tmp/somefile.ogg -f null -` validates the codec works
  outside Memphis

## Failure modes

| Symptom | Diagnosis |
|---|---|
| "voice quota exceeded" on first call | `MEMPHIS_VOICE_DAILY_LIMIT=0` in env, lift it or unset |
| "huggingface api: 401" | Vault entry exists but token is invalid; `memphis vault list \| grep huggingface` then re-add |
| "ffmpeg not found" | `scripts/install-prerequisites.sh` didn't run or failed; re-run + check `which ffmpeg` |
| "no audio device" in TUI | ALSA not configured for the operator's user; usually means Linux audio stack issue, not Memphis |

## Out of scope

- Realtime streaming TTS (chunked by sentence) — not yet implemented;
  voice replies arrive as one finished file per turn.
- Voice cloning / custom voices — not exposed; uses the provider's
  default voice for the configured language.
- Mic-capture from the daemon (without TUI) — Whisper STT today is
  invoked from TUI/Telegram, not as a daemon-side service.
