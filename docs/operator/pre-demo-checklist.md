# Pre-demo checklist

Step-by-step ops procedure to run **2 hours before any public-facing demo** of Memphis. The goal: catch every "I forgot to deploy that fix" trap before the audience is watching.

The checklist covers the build → restart → smoke-test cycle. It's intentionally conservative: a 2-hour buffer means even a rebuild-from-scratch (which is the longest path here) leaves time to recover.

The reference scenario this was first written for: **2026-05-06 19:00** Polish-language demo at memphis-v5.pl/zaproszenie/, with the operator's i3-2120 Sandy Bridge host as the production runtime. Adapt thresholds (CPU, voice models, ports) to your own deploy.

## Prerequisites

- Memphis cloned at `~/memphis` (or wherever `MEMPHIS_INSTALL_ROOT` points).
- `systemctl --user status memphis` returns "active (running)" most of the day.
- `~/.memphis/` data dir is the canonical one (vault + chains + soul live there).
- voice stack: `faster-whisper` server on port 9000, `Piper` HTTP on port 5500. See `docs/operator/voice-local-stt.md` and `voice-local-tts.md` for the install runbook.

If any of those isn't true, the checklist below is the wrong starting point — run a clean install first (`docs/operator/CLEAN-INSTALL.md`).

## T-2h — Build + restart

The host has been running for hours/days. Recent merges to `main` since the last service restart are NOT live. Pull, rebuild, restart, verify.

```bash
cd ~/memphis

# 1. Sync main + check what's newly merged since last restart
git pull --ff-only origin main
git log --oneline --since "$(systemctl --user show memphis -p ActiveEnterTimestamp --value)" | head -20

# 2. Rebuild TypeScript dist + Rust release artifacts
#    build:rust:release produces target/release/libmemphis_napi.so AND
#    copies it to crates/memphis-napi/index.node (per scripts/run-rust.sh).
npm run build:rust:release
npm run build           # dev rust + tsc — but tsc is what we need

# 3. Confirm index.node is the release build (smaller than dev: ~7MB vs ~55MB)
ls -lh crates/memphis-napi/index.node

# 4. Restart service
systemctl --user restart memphis

# 5. Watch first 10 seconds — must reach "Server listening at http://127.0.0.1:3100"
journalctl --user -u memphis --since "30 sec ago" --follow
# Ctrl-C once you see the listening line. No SIGILL, no fatal errors.
```

### Smoke validation

```bash
# Doctor — every probe must report green
memphis doctor

# Voice stack: STT + TTS reachable, both ports respond
memphis voice status

# Quick chat — minimal turn through the full pipeline
echo 'ping' | memphis chat 2>&1 | tail -5
```

If any of these is red, **stop and triage** — don't go into the demo with a broken probe. The doctor probes are wired to surface specific known-bad states; trusting them is the cheap path.

## T-1h — Voice live test

The single highest-risk path on demo day is voice (Telegram voice msg → STT → bot → TTS → voice reply). Test with real audio at least once.

- Send a short voice message (3-5s) via Telegram to the bot.
- Bot should reply with a transcription preview ("[Transkrypcja] …") within a few seconds.
- Bot should follow up with a voice reply (TTS).
- Test a longer message (~30s) — this exercises the 90s STT timeout (#477). On CUDA the `medium` model finishes in 1-3s; on CPU fallback it can take >30s, which is exactly why the timeout was bumped from 30s to 90s.

If voice fails, common culprits:
1. `whisper` server not started (port 9000 dead) — check `ps aux | grep whisper`.
2. `Piper` server not started (port 5500 dead) — check `ps aux | grep piper`.
3. STT timing out at exactly 30s → the `dist/` is stale (#477 not deployed). Re-run T-2h step 2.
4. ffmpeg not installed → `which ffmpeg`. Install via `apt install ffmpeg`.

## T-0 (demo start)

```bash
# 1. Tail logs in a dedicated terminal — second screen ideally
journalctl --user -u memphis -f

# 2. Confirm tier is 2 (default). Don't elevate to tier 3 for a public demo
#    unless the demo specifically shows tier-3 features.
memphis tier status

# 3. (optional) Have a backup plan. If host crashes mid-demo:
#    - keep ~/memphis-deploy/ snapshot on a second LAN host
#    - know the SSH command to run `memphis serve` there
```

## Post-demo

- **Rotate any tier-3 passphrase you exposed during the session.** Tier-3 elevation passphrases are sensitive; if you typed one during a screencast or paired session, treat it as compromised and rotate.
- Capture a one-line note in the journal chain: `memphis journal "demo $(date) — went smoothly / hit issue X"`. Post-mortem context is gold for the next demo.
- If the demo revealed a bug, file an issue with `journalctl --user -u memphis --since "1 hour ago"` attached.

## Quick reference: what landed since the last restart

```bash
# Lists every commit on main that postdates the running service start.
# Useful at T-2h to know "what's NOT yet live".
git log --oneline --since "$(systemctl --user show memphis -p ActiveEnterTimestamp --value)" main
```
