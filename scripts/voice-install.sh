#!/usr/bin/env bash
# Memphis local voice stack installer — Sprint H decision lock 2026-05-04.
#
#   STT  faster-whisper medium INT8 → http://127.0.0.1:9000   (CUDA, falls back to CPU)
#   TTS  Piper                       → http://127.0.0.1:5500   (CPU only, ~80 MB / voice)
#
# Both Polish voices are downloaded by default — pick the active one
# with --voice. Stick a request header `X-Voice: gosia|darkman` on POST
# /api/tts to override per-request without restarting.
#
#   gosia    pl_PL-gosia-medium    female (default)
#   darkman  pl_PL-darkman-medium  male
#
# Idempotent: safe to re-run. Skips any piece already in place. Does NOT
# touch your `.env` — `memphis voice install` writes the env var pins
# separately (or you set MEMPHIS_VOICE_MODE=local manually).
#
# One-shot use:           memphis voice install
# Pick male voice:        memphis voice install --voice darkman
# Direct use:             bash scripts/voice-install.sh
# Restart servers only:   bash scripts/voice-install.sh --restart [--voice darkman]
# Stop servers:           bash scripts/voice-install.sh --stop

set -uo pipefail

VENV="${MEMPHIS_VOICE_VENV:-$HOME/.cache/whisper-server-venv}"
PIPER_DIR="${MEMPHIS_PIPER_DIR:-$HOME/piper}"
WHISPER_PORT="${MEMPHIS_WHISPER_PORT:-9000}"
PIPER_PORT="${MEMPHIS_PIPER_PORT:-5500}"
WHISPER_MODEL="${MEMPHIS_WHISPER_MODEL:-medium}"
WHISPER_DEVICE="${MEMPHIS_WHISPER_DEVICE:-cuda}"
WHISPER_COMPUTE="${MEMPHIS_WHISPER_COMPUTE:-int8}"
PIPER_VOICE_DEFAULT="${MEMPHIS_PIPER_VOICE:-gosia}"
WHISPER_LOG="${MEMPHIS_WHISPER_LOG:-/tmp/whisper-server.log}"
PIPER_LOG="${MEMPHIS_PIPER_LOG:-/tmp/piper-server.log}"
WHISPER_SCRIPT="${MEMPHIS_WHISPER_SCRIPT:-/tmp/memphis-whisper-server.py}"
PIPER_SCRIPT="${MEMPHIS_PIPER_SCRIPT:-/tmp/memphis-piper-server.py}"

# Voice catalog: short-name → upstream-path | onnx-filename | description.
# Path = `pl/pl_PL/<short>/medium` on huggingface.co/rhasspy/piper-voices.
# Add a row + the short-name validation list to support a new voice.
voice_path_for()  { case "$1" in
  gosia)    echo "pl/pl_PL/gosia/medium" ;;
  darkman)  echo "pl/pl_PL/darkman/medium" ;;
  *)        return 1 ;;
esac; }
voice_file_for()  { case "$1" in
  gosia)    echo "pl_PL-gosia-medium" ;;
  darkman)  echo "pl_PL-darkman-medium" ;;
  *)        return 1 ;;
esac; }
voice_label_for() { case "$1" in
  gosia)    echo "female (Polish)" ;;
  darkman)  echo "male (Polish)" ;;
  *)        echo "?" ;;
esac; }
KNOWN_VOICES=(gosia darkman)

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
  # Primary paths (current installer).
  pkill -f "$WHISPER_SCRIPT" 2>/dev/null && ok "killed whisper" || true
  pkill -f "$PIPER_SCRIPT"   2>/dev/null && ok "killed piper"   || true
  # Legacy paths from older / external installer recipes. Without
  # these, an orphan server keeps the port and the new server fails
  # to bind silently (you'd see /health responses from the OLD code
  # and wonder why your --voice change didn't take effect).
  for legacy in \
      /tmp/whisper-server.py \
      /tmp/piper-server.py \
      /tmp/whisper-server-runbook.py \
      "$HOME/whisper-server.py" \
      "$HOME/piper-server.py"; do
    pkill -f "$legacy" 2>/dev/null && ok "killed legacy server ($legacy)" || true
  done
  # Belt-and-braces: free the canonical ports if anything else still
  # holds them (rare — operator manually started a third-party piper
  # build, etc.). We won't kill arbitrary PIDs blindly; only ones
  # whose argv looks like a piper/whisper server.
  for port in "$WHISPER_PORT" "$PIPER_PORT"; do
    pid=$(ss -tlnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $0}' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
    if [ -n "${pid:-}" ]; then
      cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
      if echo "$cmd" | grep -qE 'whisper|piper'; then
        kill -9 "$pid" 2>/dev/null && ok "freed port $port (pid=$pid)" || true
      fi
    fi
  done
  sleep 1
}

# Parse args. Modes are mutually exclusive (install | --restart | --stop);
# --voice <name> attaches to install or --restart.
MODE=install
VOICE_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    install)   MODE=install; shift ;;
    --restart) MODE=restart; shift ;;
    --stop)    MODE=stop;    shift ;;
    --voice)
      VOICE_OVERRIDE="${2:-}"
      if [ -z "$VOICE_OVERRIDE" ]; then
        err "--voice requires an argument (one of: ${KNOWN_VOICES[*]})"; exit 1
      fi
      shift 2
      ;;
    --voice=*) VOICE_OVERRIDE="${1#--voice=}"; shift ;;
    *) echo "usage: $0 [install|--restart|--stop] [--voice <${KNOWN_VOICES[*]}>]"; exit 1 ;;
  esac
done

if [ "$MODE" = "stop" ]; then
  stop_servers
  exit 0
fi

ACTIVE_VOICE="${VOICE_OVERRIDE:-$PIPER_VOICE_DEFAULT}"
if ! voice_path_for "$ACTIVE_VOICE" >/dev/null 2>&1; then
  err "unknown voice: $ACTIVE_VOICE"
  echo "  Known short-names: ${KNOWN_VOICES[*]}"
  exit 1
fi
ACTIVE_VOICE_FILE=$(voice_file_for "$ACTIVE_VOICE")

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
        # Liveness paths: /health for our own probe, /inference + /v1/audio/transcriptions
        # to satisfy adapter-side GET probes (whisper.cpp clients sometimes ping
        # the inference route to verify the server is up before POSTing).
        if self.path in ("/health", "/inference", "/v1/audio/transcriptions"):
            self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
            self.wfile.write(json.dumps({"status":"ok","model":size}).encode())
        else:
            self.send_response(404); self.end_headers()
    def do_POST(self):
        # Accept BOTH conventions:
        #   /inference                        — whisper.cpp HTTP server convention
        #                                        (Memphis local-whisper-adapter.ts uses this)
        #   /v1/audio/transcriptions          — OpenAI / faster-whisper-server convention
        # Body is raw audio (audio/wav from Memphis after ffmpeg transcode).
        if self.path not in ("/inference", "/v1/audio/transcriptions"):
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

# 3. Piper binary + voices ─────────────────────────────────────────
step "TTS: Piper binary + voice catalog"
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

# Download every catalog voice that isn't already on disk. ~80 MB each
# — gosia + darkman is ~160 MB total, acceptable for the live demo box.
# A voice's absence on disk doesn't fail the install — only the active
# voice has to land. Per-voice download failures emit a warning so the
# operator sees what didn't make it.
for v in "${KNOWN_VOICES[@]}"; do
  vf=$(voice_file_for "$v") || continue
  if [ -f "$PIPER_DIR/voices/$vf.onnx" ]; then
    ok "$v ($vf) already present"
    continue
  fi
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/$(voice_path_for "$v")"
  if curl -fsSL -o "$PIPER_DIR/voices/$vf.onnx" "$base/$vf.onnx" \
     && curl -fsSL -o "$PIPER_DIR/voices/$vf.onnx.json" "$base/$vf.onnx.json"; then
    ok "$v ($vf) — $(voice_label_for "$v") — downloaded"
  else
    rm -f "$PIPER_DIR/voices/$vf.onnx" "$PIPER_DIR/voices/$vf.onnx.json"
    err "$v download failed (network? upstream rename?). Other voices unaffected."
    if [ "$v" = "$ACTIVE_VOICE" ]; then
      err "active voice $v missing — install cannot continue"
      exit 1
    fi
  fi
done

if [ ! -f "$PIPER_DIR/voices/$ACTIVE_VOICE_FILE.onnx" ]; then
  err "active voice $ACTIVE_VOICE ($ACTIVE_VOICE_FILE) is not on disk"
  echo "  Either retry with network access, or download manually into $PIPER_DIR/voices/"
  exit 1
fi
ok "active voice → $ACTIVE_VOICE ($(voice_label_for "$ACTIVE_VOICE"))"

# 4. Piper server script ───────────────────────────────────────────
step "TTS: server script ($PIPER_SCRIPT)"
# Build the SHORT_TO_FILE dict from the bash voice catalog so the Python
# server stays in sync without us hand-maintaining two truth lists.
catalog_pairs=""
for v in "${KNOWN_VOICES[@]}"; do
  catalog_pairs+="    '$v': '$(voice_file_for "$v")',
"
done
cat > "$PIPER_SCRIPT" <<PYEOF
import subprocess, tempfile, os, json, urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

VOICE_DIR = os.path.expanduser('$PIPER_DIR/voices')
PIPER = os.path.expanduser('$PIPER_DIR/piper')
DEFAULT_VOICE = '$ACTIVE_VOICE'

# short-name → onnx-basename. Generated from scripts/voice-install.sh
# bash catalog. To add a voice: edit voice_path_for/voice_file_for and
# re-run installer; this dict is regenerated on every install.
SHORT_TO_FILE = {
$catalog_pairs}

def model_path(short):
    short = (short or DEFAULT_VOICE).strip().lower()
    if short not in SHORT_TO_FILE:
        return None
    p = os.path.join(VOICE_DIR, SHORT_TO_FILE[short] + '.onnx')
    return p if os.path.isfile(p) else None

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
            available = [v for v in SHORT_TO_FILE if model_path(v)]
            self.wfile.write(json.dumps({
                "status": "ok",
                "voice": DEFAULT_VOICE,
                "available": available,
            }).encode())
        elif self.path == '/voices':
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(json.dumps({
                "default": DEFAULT_VOICE,
                "voices": [{"name": v, "available": bool(model_path(v))} for v in SHORT_TO_FILE],
            }).encode())
        elif self.path.startswith('/api/tts'):
            # checkPiperServerHealth() in local-piper-adapter.ts does a
            # GET on /api/tts and accepts 200/204/405 as "route exists".
            # Return 200 so the adapter's liveness probe stays green
            # without triggering model load.
            self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(b'{"ok": true}')
        else:
            self.send_response(404); self.end_headers()

    def do_POST(self):
        # Path may be /api/tts or /api/tts?voice=darkman.
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != '/api/tts':
            self.send_response(404); self.end_headers(); return
        # Voice selection priority: ?voice= query → X-Voice header → DEFAULT_VOICE.
        qs = urllib.parse.parse_qs(parsed.query)
        voice = (qs.get('voice') or [None])[0] or self.headers.get('X-Voice') or DEFAULT_VOICE
        mp = model_path(voice)
        if mp is None:
            self.send_response(400); self.send_header('Content-Type','application/json'); self.end_headers()
            self.wfile.write(json.dumps({
                "error": "voice_unavailable",
                "requested": voice,
                "available": [v for v in SHORT_TO_FILE if model_path(v)],
            }).encode())
            return
        n = int(self.headers.get('Content-Length', '0'))
        text = self.rfile.read(n).decode('utf-8')
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as out:
            wav_path = out.name
        try:
            subprocess.run(
                [PIPER, '--model', mp, '--output_file', wav_path],
                input=text.encode('utf-8'), check=True,
                stderr=subprocess.DEVNULL,
            )
            with open(wav_path, 'rb') as f: audio = f.read()
        finally:
            try: os.unlink(wav_path)
            except OSError: pass
        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('X-Voice-Used', voice)
        self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *a): pass

print(f'[piper] default voice: {DEFAULT_VOICE} ({SHORT_TO_FILE.get(DEFAULT_VOICE,"?")})', flush=True)
print(f'[piper] available: {[v for v in SHORT_TO_FILE if model_path(v)]}', flush=True)
print('[piper] listening on 127.0.0.1:$PIPER_PORT', flush=True)
HTTPServer(('127.0.0.1', $PIPER_PORT), H).serve_forever()
PYEOF
ok "wrote $PIPER_SCRIPT (default voice → $ACTIVE_VOICE)"

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
Active   voice: $ACTIVE_VOICE ($(voice_label_for "$ACTIVE_VOICE"))
Logs:    tail -f $WHISPER_LOG
         tail -f $PIPER_LOG
Restart: memphis voice install --restart
Switch:  memphis voice install --restart --voice darkman   # male
         memphis voice install --restart --voice gosia     # female
Stop:    memphis voice install --stop

Per-request override (no restart needed):
  curl -s http://127.0.0.1:$PIPER_PORT/voices                # see catalog
  curl -s -H 'X-Voice: darkman' --data 'Cześć!' \\
       http://127.0.0.1:$PIPER_PORT/api/tts -o out.wav

Set MEMPHIS_VOICE_MODE=local in your .env (or shell), then verify:
  memphis voice status
────────────────────────────────────────────────────────────
MSG
