# Local STT runbook — faster-whisper / whisper.cpp

> Sprint H PR-A • 2026-05-04 • Decision lock: `docs/dev/voice-stack-decision-2026-05-04.md`

## TL;DR — fresh-install one-liner

```bash
memphis voice install
```

Idempotent: pulls faster-whisper into a venv, downloads Piper + Polish voice, writes both server scripts to `/tmp/`, starts both as background processes, prints health. Re-runs are seconds. `memphis voice install --restart` restarts; `memphis voice install --stop` stops.

After it finishes:
```bash
echo MEMPHIS_VOICE_MODE=local >> ~/memphis/.env   # if not already pinned
memphis voice status                              # both engines reachable
```

The rest of this document is the manual recipe + customization knobs (alternative voices, GPU↔CPU, port overrides) the one-liner abstracts away.

## Why

Memphis routes Telegram voice (and any future voice surface) through `voice-service.ts`. Cloud route hits HuggingFace's `whisper-large-v3` Inference API; local route hits a host-side STT server on `WHISPER_SERVER_URL`. Local mode unblocks the offline live demo.

## Recommended engine: faster-whisper `medium` INT8

- ~1.2 GB VRAM, ~770M params
- 6× faster than vanilla Whisper, 99% large-v3 accuracy
- Polish well-supported (multilingual training)
- INT8 quantization coexists with Kartograf inference (~1 GB VRAM) inside the 4 GB GTX 960 cap

Alternative: `whisper.cpp` with `ggml-medium-q5_0.bin` if Python toolchain isn't an option (CPU fallback works, slower).

## Install (Linux / GTX 960)

```bash
# 1. Install faster-whisper
pip install faster-whisper

# 2. Pull the model (one-time, ~1.5 GB download)
python -c "from faster_whisper import WhisperModel; WhisperModel('medium', device='cuda', compute_type='int8')"

# 3. Run the HTTP server (idiomatic faster-whisper does NOT ship a built-in
#    server — use `whispercpp-server` or this minimal wrapper saved as
#    ~/whisper-server.py):
cat > ~/whisper-server.py <<'PY'
import sys, io, json
from http.server import BaseHTTPRequestHandler, HTTPServer
from faster_whisper import WhisperModel

MODEL = WhisperModel('medium', device='cuda', compute_type='int8')

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(b'{"ok": true}')
    def do_POST(self):
        if not self.path.endswith('/inference'):
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get('Content-Length', '0'))
        body = self.rfile.read(n)
        with open('/tmp/in.wav', 'wb') as f: f.write(body)
        segs, _ = MODEL.transcribe('/tmp/in.wav', language='pl', vad_filter=True)
        text = ' '.join(s.text for s in segs)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'text': text}).encode('utf-8'))

HTTPServer(('127.0.0.1', 9000), H).serve_forever()
PY

# 4. Start (background)
python ~/whisper-server.py &

# 5. Verify
curl http://localhost:9000/   # → {"ok": true}
```

## Memphis runtime config

```bash
# Force local route (operator demo box)
export MEMPHIS_VOICE_MODE=local

# Or auto-pick (local when HF token absent, cloud when present)
export MEMPHIS_VOICE_MODE=auto

# Override server URL if not on 9000
export WHISPER_SERVER_URL=http://localhost:9001
```

Then:

```bash
memphis tui                    # voice off by default
# inside TUI: /voice on
# OR via Telegram: /voice on (per chat)
```

## Verification

```bash
# Doctor check (after Sprint H PR-C lands)
memphis doctor 2>&1 | grep voice
# → ta12-voice-stack: pass — STT(local @ http://localhost:9000), TTS(...)

# Direct STT smoke test (when whisper server is up)
curl -X POST -H 'Content-Type: audio/wav' --data-binary @sample-pl.wav \
  http://localhost:9000/inference
# → {"text": "Sample polish transcription"}
```

## Latency expectations

- Audio length 5s, GTX 960 + medium INT8: ~600–900 ms transcription
- VRAM during inference: ~1.2 GB
- Idle VRAM (model loaded): ~1.0 GB

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `Whisper server error (503)` | Server crashed (OOM most likely) | `nvidia-smi` to confirm VRAM headroom; restart server, drop to `compute_type='int8_float32'` |
| `STT failed (404)` from Memphis | Wrong endpoint | Server runbook expects `/inference`; whisper.cpp's `whisper-server` also uses `/inference` |
| `ffmpeg: command not found` | OGG→WAV transcode prereq missing | `apt install ffmpeg` (or platform equivalent) |
| `text` empty consistently | Polish audio detected as English | Force language: server runbook above pins `language='pl'`; for whisper.cpp use `-l pl` flag |

## Switching back to cloud

```bash
export MEMPHIS_VOICE_MODE=cloud   # forces HF API even if local server is up
# or
unset MEMPHIS_VOICE_MODE          # back to auto
```

## Related

- `docs/dev/voice-stack-decision-2026-05-04.md` — engine selection rationale
- `docs/operator/voice-local-tts.md` — Piper TTS runbook (Sprint H PR-B, queued)
- `docs/operator/voice.md` — original cloud-mode runbook
- `src/gateway/voice/voice-service.ts:resolveVoiceConfig` — chooser logic
- `src/gateway/voice/local-whisper-adapter.ts` — adapter implementation
