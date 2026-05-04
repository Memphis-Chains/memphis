# Local TTS runbook — Piper

> Sprint H PR-B • 2026-05-04 • Decision lock: `docs/dev/voice-stack-decision-2026-05-04.md`

## TL;DR — fresh-install one-liner

```bash
memphis voice install
```

Pulls the Piper binary + `pl_PL-gosia-medium` voice (~80 MB) and starts the HTTP server on `:5500` alongside faster-whisper STT on `:9000`. See `voice-local-stt.md` for the full one-liner story; this runbook covers the manual recipe + customization paths only.

## Why

Piper runs entirely on CPU (~80 MB), <100 ms latency, no GPU contention with STT or Kartograf. Polish voice (`pl_PL-gosia-medium.onnx`) is ONNX-backed — same runtime as Kartograf — and maintained upstream by the [rhasspy/piper](https://github.com/rhasspy/piper) project.

## Recommended voice: `pl_PL-gosia-medium`

- ~80 MB model + config files
- 22050 Hz, 16-bit WAV output
- Polish-trained, decent prosody for conversational text
- Quality alternative if gosia sounds too synthetic: `pl_PL-mc_speech-medium`

## Install (Linux x86_64)

```bash
# 1. Pull the Piper binary release
curl -L -o /tmp/piper.tgz \
  https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz
mkdir -p ~/piper && tar xzf /tmp/piper.tgz -C ~/piper --strip-components=1

# 2. Pull the Polish voice files (~80 MB)
mkdir -p ~/piper/voices
cd ~/piper/voices
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx.json

# 3. Smoke test (writes test.wav)
echo "Cześć, jestem Memphis." | ~/piper/piper \
  --model ~/piper/voices/pl_PL-gosia-medium.onnx \
  --output_file /tmp/test.wav
aplay /tmp/test.wav   # or play via VLC / mpv
```

## Run as HTTP server

Memphis routes through `POST $PIPER_SERVER_URL/api/tts` with a plain-text body. The Piper binary supports `--http_port` directly in recent releases; if your build doesn't, use the wrapper below (saved as `~/piper-server.py`):

```python
#!/usr/bin/env python3
import subprocess, tempfile, os
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = os.path.expanduser('~/piper/voices/pl_PL-gosia-medium.onnx')
PIPER = os.path.expanduser('~/piper/piper')

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers()
        self.wfile.write(b'{"ok": true}')
    def do_POST(self):
        if not self.path.startswith('/api/tts'):
            self.send_response(404); self.end_headers(); return
        n = int(self.headers.get('Content-Length', '0'))
        text = self.rfile.read(n).decode('utf-8')
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as out:
            wav_path = out.name
        try:
            subprocess.run(
                [PIPER, '--model', MODEL, '--output_file', wav_path],
                input=text.encode('utf-8'), check=True,
                stderr=subprocess.DEVNULL,
            )
            with open(wav_path, 'rb') as f: audio = f.read()
        finally:
            try: os.unlink(wav_path)
            except OSError: pass
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

HTTPServer(('127.0.0.1', 5500), H).serve_forever()
```

```bash
chmod +x ~/piper-server.py
python ~/piper-server.py &

# Verify
curl http://localhost:5500/                        # → {"ok": true}
curl -X POST -H 'Content-Type: text/plain' \
  --data 'Cześć Memphis' http://localhost:5500/api/tts \
  --output /tmp/out.wav
aplay /tmp/out.wav
```

## Memphis runtime config

```bash
# Force local route (operator demo box)
export MEMPHIS_VOICE_MODE=local

# Optional override if Piper isn't on default port
export PIPER_SERVER_URL=http://localhost:5501
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
# → ta12-voice-stack: pass — STT(local @ :9000), TTS(local @ :5500)

# End-to-end smoke (Telegram or TUI)
# Send a voice message in Polish → bot transcribes via STT → replies via TTS in Polish
```

## Latency expectations

- Text length 100 chars, CPU-only: ~50–80 ms synthesis
- Text length 500 chars: ~200–300 ms
- RAM: ~100 MB resident with model loaded
- VRAM: zero (CPU-only by design)

## Quality + voice options

If `gosia-medium` doesn't fit:

| Voice | Style | File size |
|---|---|---|
| `pl_PL-gosia-medium` (default) | conversational, female | ~80 MB |
| `pl_PL-mc_speech-medium` | broadcast, female | ~80 MB |
| `pl_PL-darkman-medium` | male, deeper | ~80 MB |

Drop the `.onnx` + `.onnx.json` files into `~/piper/voices/` and point the server at the new model path.

## Troubleshooting

| Symptom | Diagnosis | Fix |
|---|---|---|
| `Piper server error (404)` | Wrong endpoint | Wrapper above expects `/api/tts`; if using piper-tts-server with different convention, update `local-piper-adapter.ts:piperServerSynthesizeUrl()` |
| `ECONNREFUSED` from Memphis | Server not running | `ps aux \| grep piper-server.py`; restart |
| Audio sounds like static | WAV header corrupt | Some Piper builds emit raw PCM; force WAV via `--output_raw=false` flag in wrapper |
| Voice cuts off mid-sentence | Buffer flushing race | Add `--quiet --json_input` to piper command in wrapper |
| Polish diacritics dropped | Encoding | Ensure wrapper writes UTF-8 (`text.encode('utf-8')`) |

## Switching back to cloud TTS

```bash
export MEMPHIS_VOICE_MODE=cloud   # forces HF or Google API
# or
unset MEMPHIS_VOICE_MODE          # back to auto
```

## Related

- `docs/dev/voice-stack-decision-2026-05-04.md` — engine selection rationale
- `docs/operator/voice-local-stt.md` — faster-whisper STT runbook (Sprint H PR-A)
- `src/gateway/voice/voice-service.ts:textToSpeech` — chooser logic
- `src/gateway/voice/local-piper-adapter.ts` — adapter implementation
