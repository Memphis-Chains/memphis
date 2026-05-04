#!/usr/bin/env bash
# Memphis local voice stack installer — Sprint H decision lock 2026-05-04.
#
#   STT  faster-whisper medium INT8 → http://127.0.0.1:9000   (CUDA, falls back to CPU)
#   TTS  Piper pl_PL-gosia-medium   → http://127.0.0.1:5500   (CPU only, ~80 MB)
#
# Idempotent: safe to re-run. Skips any piece already in place. Does NOT
# touch your `.env` — `memphis voice install` writes the env var pins
# separately (or you set MEMPHIS_VOICE_MODE=local manually).
#
# One-shot use:           memphis voice install
# Direct use:             bash scripts/voice-install.sh
# Restart servers only:   bash scripts/voice-install.sh --restart
# Stop servers:           bash scripts/voice-install.sh --stop

set -uo pipefail

VENV="${MEMPHIS_VOICE_VENV:-$HOME/.cache/whisper-server-venv}"
PIPER_DIR="${MEMPHIS_PIPER_DIR:-$HOME/piper}"
WHISPER_PORT="${MEMPHIS_WHISPER_PORT:-9000}"
PIPER_PORT="${MEMPHIS_PIPER_PORT:-5500}"
WHISPER_MODEL="${MEMPHIS_WHISPER_MODEL:-medium}"
WHISPER_DEVICE="${MEMPHIS_WHISPER_DEVICE:-cuda}"
WHISPER_COMPUTE="${MEMPHIS_WHISPER_COMPUTE:-int8}"
PIPER_VOICE="${MEMPHIS_PIPER_VOICE:-pl_PL-gosia-medium}"
WHISPER_LOG="${MEMPHIS_WHISPER_LOG:-/tmp/whisper-server.log}"
PIPER_LOG="${MEMPHIS_PIPER_LOG:-/tmp/piper-server.log}"
WHISPER_SCRIPT="${MEMPHIS_WHISPER_SCRIPT:-/tmp/memphis-whisper-server.py}"
PIPER_SCRIPT="${MEMPHIS_PIPER_SCRIPT:-/tmp/memphis-piper-server.py}"

step() { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*"; }
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "missing prerequisite: $1"
    echo "  Install on Debian/Ubuntu: sudo apt install -y $2"
    exit 1
  fi
}

stop_servers() {
  pkill -f "$WHISPER_SCRIPT" 2>/dev/null && ok "killed whisper" || true
  pkill -f "$PIPER_SCRIPT"   2>/dev/null && ok "killed piper"   || true
  sleep 1
}

case "${1:-install}" in
  --stop) stop_servers; exit 0 ;;
  --restart|install|"") ;;
  *) echo "usage: $0 [--restart|--stop]"; exit 1 ;;
esac

# Prerequisites ────────────────────────────────────────────────────
step "Prerequisites"
need python3 "python3 python3-venv"
need curl "curl"
need tar "tar"
ok "python3 / curl / tar found"

# 1. faster-whisper venv ───────────────────────────────────────────
step "STT: faster-whisper venv"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
  ok "venv created at $VENV"
else
  ok "venv exists"
fi
if ! "$VENV/bin/python" -c "import faster_whisper" 2>/dev/null; then
  "$VENV/bin/pip" install --quiet --upgrade pip
  "$VENV/bin/pip" install --quiet faster-whisper
  ok "faster-whisper installed"
else
  ok "faster-whisper already installed"
fi

# 2. STT server script ─────────────────────────────────────────────
step "STT: server script ($WHISPER_SCRIPT)"
cat > "$WHISPER_SCRIPT" <<PYEOF
import sys, json, tempfile, os
from http.server import BaseHTTPRequestHandler, HTTPServer
from faster_whisper import WhisperModel

device = os.environ.get("WHISPER_DEVICE", "$WHISPER_DEVICE")
compute = os.environ.get("WHISPER_COMPUTE", "$WHISPER_COMPUTE")
size = os.environ.get("WHISPER_MODEL", "$WHISPER_MODEL")
print(f"[whisper] loading {size} {device}/{compute}...", flush=True)
try:
    model = WhisperModel(size, device=device, compute_type=compute)
except Exception as e:
    print(f"[whisper] {device}/{compute} init failed ({e}); falling back to cpu/int8", flush=True)
    model = WhisperModel(size, device="cpu", compute_type="int8")
print("[whisper] ready", flush=True)

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"status":"ok","model":size}).encode())
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        if self.path != "/v1/audio/transcriptions":
            self.send_response(404); self.end_headers(); return
        ln = int(self.headers.get("Content-Length","0"))
        body = self.rfile.read(ln)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(body); path = f.name
        try:
            segs, info = model.transcribe(path, language="pl")
            text = " ".join(s.text for s in segs).strip()
            self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"text": text, "language": info.language}).encode())
        finally:
            os.unlink(path)
    def log_message(self, *a): pass

print(f"[whisper] listening on 127.0.0.1:$WHISPER_PORT", flush=True)
HTTPServer(("127.0.0.1", $WHISPER_PORT), H).serve_forever()
PYEOF
ok "wrote $WHISPER_SCRIPT"

# 3. Piper binary + voice ──────────────────────────────────────────
step "TTS: Piper binary + $PIPER_VOICE"
mkdir -p "$PIPER_DIR/voices"
if [ ! -x "$PIPER_DIR/piper" ]; then
  curl -sL -o /tmp/piper.tgz \
    https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz
  tar xzf /tmp/piper.tgz -C "$PIPER_DIR" --strip-components=1
  rm /tmp/piper.tgz
  ok "piper binary installed at $PIPER_DIR/piper"
else
  ok "piper binary exists"
fi
if [ ! -f "$PIPER_DIR/voices/$PIPER_VOICE.onnx" ]; then
  # Voice path: pl/pl_PL/gosia/medium for pl_PL-gosia-medium. Generic
  # mapping — a different voice will need a different upstream path,
  # so we keep $PIPER_VOICE override but document that defaulting
  # works only for gosia. Operators wanting another voice should
  # download manually.
  if [ "$PIPER_VOICE" = "pl_PL-gosia-medium" ]; then
    base="https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium"
    curl -sL -o "$PIPER_DIR/voices/$PIPER_VOICE.onnx"      "$base/$PIPER_VOICE.onnx"
    curl -sL -o "$PIPER_DIR/voices/$PIPER_VOICE.onnx.json" "$base/$PIPER_VOICE.onnx.json"
    ok "$PIPER_VOICE downloaded"
  else
    err "voice $PIPER_VOICE: auto-download only supported for pl_PL-gosia-medium"
    echo "  Manually place $PIPER_VOICE.onnx + .onnx.json in $PIPER_DIR/voices/"
    exit 1
  fi
else
  ok "$PIPER_VOICE already present"
fi

# 4. Piper server script ───────────────────────────────────────────
step "TTS: server script ($PIPER_SCRIPT)"
cat > "$PIPER_SCRIPT" <<PYEOF
import subprocess, tempfile, os, json
from http.server import BaseHTTPRequestHandler, HTTPServer

MODEL = os.path.expanduser('$PIPER_DIR/voices/$PIPER_VOICE.onnx')
PIPER = os.path.expanduser('$PIPER_DIR/piper')

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(json.dumps({"status":"ok","voice":"$PIPER_VOICE"}).encode())
        else:
            self.send_response(404); self.end_headers()
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
    def log_message(self, *a): pass

print('[piper] listening on 127.0.0.1:$PIPER_PORT', flush=True)
HTTPServer(('127.0.0.1', $PIPER_PORT), H).serve_forever()
PYEOF
ok "wrote $PIPER_SCRIPT"

# 5. (Re)start ─────────────────────────────────────────────────────
step "Restart: stop any prior servers"
stop_servers

step "Start: nohup background"
nohup "$VENV/bin/python" "$WHISPER_SCRIPT" > "$WHISPER_LOG" 2>&1 &
WHISPER_PID=$!
ok "whisper started PID=$WHISPER_PID (log: $WHISPER_LOG)"
nohup python3 "$PIPER_SCRIPT" > "$PIPER_LOG" 2>&1 &
PIPER_PID=$!
ok "piper started PID=$PIPER_PID (log: $PIPER_LOG)"

# 6. Verify ────────────────────────────────────────────────────────
step "Verify: waiting for servers (whisper model load takes ~30-60s on first start)"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$WHISPER_PORT/health" >/dev/null 2>&1 \
     && curl -fsS "http://127.0.0.1:$PIPER_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

WSTAT=$(curl -fsS "http://127.0.0.1:$WHISPER_PORT/health" 2>&1 || echo DOWN)
PSTAT=$(curl -fsS "http://127.0.0.1:$PIPER_PORT/health"   2>&1 || echo DOWN)
echo
[ "$WSTAT" != DOWN ] && ok "STT  $WSTAT"  || { err "STT  not responding"; tail -n 20 "$WHISPER_LOG"; }
[ "$PSTAT" != DOWN ] && ok "TTS  $PSTAT"  || { err "TTS  not responding"; tail -n 20 "$PIPER_LOG"; }

cat <<MSG

────────────────────────────────────────────────────────────
PIDs:    whisper=$WHISPER_PID  piper=$PIPER_PID
Logs:    tail -f $WHISPER_LOG
         tail -f $PIPER_LOG
Restart: memphis voice install --restart
Stop:    memphis voice install --stop

Set MEMPHIS_VOICE_MODE=local in your .env (or shell), then verify:
  memphis voice status
────────────────────────────────────────────────────────────
MSG
