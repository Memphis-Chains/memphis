#!/bin/bash
# /.memphis AI Stack Setup Script
# Run as: bash setup_memphis.sh

set -e
echo "=== /.memphis AI Stack Setup ==="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as memphis user
if [ "$(whoami)" != "memphis" ]; then
    echo -e "${RED}Error: Must run as 'memphis' user${NC}"
    exit 1
fi

# Configuration
MEMPHIS_HOME="/home/memphis"
OPENCLAW_HOME="$MEMPHIS_HOME/.openclaw"
VOSK_VENV="$OPENCLAW_HOME/workspace/vosk-venv"
VOSK_MODELS="$OPENCLAW_HOME/workspace/vosk-models"
OLLAMA_URL="http://localhost:11434"

# Function to print status
print_status() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Step 1: Install system dependencies
echo ""
echo "=== Step 1: System Dependencies ==="
if ! command -v ffmpeg &> /dev/null; then
    print_warning "FFmpeg not found. Audio conversion may not work properly."
    echo "Install with: sudo apt-get install ffmpeg"
fi

if ! command -v curl &> /dev/null; then
    print_error "curl is required"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    print_warning "jq not found. JSON parsing may not work."
    echo "Install with: sudo apt-get install jq"
fi

# Step 2: Setup directories
echo ""
echo "=== Step 2: Directory Structure ==="
mkdir -p "$OPENCLAW_HOME/workspace"
mkdir -p "$VOSK_MODELS"
mkdir -p "$MEMPHIS_HOME/.memphis/logs"
print_status "Directories created"

# Step 3: Install Ollama
echo ""
echo "=== Step 3: Ollama LLM ==="
if ! command -v ollama &> /dev/null; then
    print_status "Installing Ollama..."
    curl -fsSL https://ollama.com/install.sh | sh
else
    print_status "Ollama already installed"
fi

# Start Ollama service
if ! systemctl --user is-active --quiet ollama; then
    print_status "Starting Ollama service..."
    systemctl --user start ollama
    systemctl --user enable ollama
    sleep 3
fi

# Check Ollama status
if curl -s "$OLLAMA_URL/api/tags" > /dev/null 2>&1; then
    print_status "Ollama is running"
else
    print_error "Ollama not responding. Starting manually..."
    ollama serve > "$MEMPHIS_HOME/.memphis/logs/ollama.log" 2>&1 &
    sleep 5
fi

# Step 4: Pull LLM models
echo ""
echo "=== Step 4: LLM Models ==="
MODELS=("qwen3.5:0.8b" "nomic-embed-text:latest")

for model in "${MODELS[@]}"; do
    if ollama list | grep -q "$model"; then
        print_status "$model already installed"
    else
        print_status "Pulling $model..."
        ollama pull "$model" 2>&1 | tee "$MEMPHIS_HOME/.memphis/logs/ollama_pull_${model//:/_}.log"
    fi
done

# Step 5: Install Vosk STT
echo ""
echo "=== Step 5: Vosk STT ==="
if [ ! -d "$VOSK_VENV" ]; then
    print_status "Creating Python virtual environment..."
    python3 -m venv "$VOSK_VENV"
fi

# Install Vosk
print_status "Installing Vosk dependencies..."
"$VOSK_VENV/bin/pip" install vosk soundfile numpy websockets > "$MEMPHIS_HOME/.memphis/logs/vosk_install.log" 2>&1

# Download Polish model
echo ""
echo "=== Step 6: Polish Vosk Model ==="
MODEL_NAME="vosk-model-small-pl-0.22"
MODEL_URL="https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip"

if [ ! -d "$VOSK_MODELS/$MODEL_NAME" ]; then
    print_status "Downloading Polish Vosk model..."
    cd "$VOSK_MODELS"
    
    if command -v wget &> /dev/null; then
        wget -q "$MODEL_URL" -O model.zip
    else
        curl -s -L "$MODEL_URL" -o model.zip
    fi
    
    print_status "Extracting model..."
    unzip -q model.zip
    rm model.zip
    print_status "Model downloaded to: $VOSK_MODELS/$MODEL_NAME"
else
    print_status "Model already exists at: $VOSK_MODELS/$MODEL_NAME"
fi

# Step 7: Create Vosk server script
echo ""
echo "=== Step 7: Vosk STT Server ==="
VOSK_SERVER="$OPENCLAW_HOME/workspace/vosk_server.py"

cat > "$VOSK_SERVER" << 'EOF'
#!/usr/bin/env python3
"""
Vosk STT Server for /.memphis
"""

import os
import sys
import json
import tempfile
import wave
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import subprocess

# Add Vosk venv to path
venv_path = "/home/memphis/.openclaw/workspace/vosk-venv"
sys.path.insert(0, f"{venv_path}/lib/python3.12/site-packages")

try:
    from vosk import Model, KaldiRecognizer, SetLogLevel
    import numpy as np
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False
    print("Vosk not available")

class VoskSTTServer(BaseHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        self.model_path = "/home/memphis/.openclaw/workspace/vosk-models/vosk-model-small-pl-0.22"
        self.model = None
        
        if VOSK_AVAILABLE and os.path.exists(self.model_path):
            try:
                SetLogLevel(-1)
                self.model = Model(self.model_path)
                print(f"Vosk model loaded: {self.model_path}")
            except Exception as e:
                print(f"Error loading model: {e}")
        
        super().__init__(*args, **kwargs)
    
    def do_GET(self):
        if self.path == '/health':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok' if self.model else 'error',
                'service': 'vosk-stt',
                'language': 'pl'
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()
    
    def do_POST(self):
        if self.path != '/transcribe':
            self.send_response(404)
            self.end_headers()
            return
        
        if not self.model:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Model not loaded'}).encode())
            return
        
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            self.send_response(400)
            self.end_headers()
            return
        
        # Read audio
        audio_data = self.rfile.read(content_length)
        
        # Save to temp file
        with tempfile.NamedTemporaryFile(suffix='.ogg', delete=False) as f:
            f.write(audio_data)
            temp_audio = f.name
        
        try:
            # Convert to WAV
            wav_file = tempfile.mktemp(suffix='.wav')
            cmd = ['ffmpeg', '-i', temp_audio, '-ar', '16000', '-ac', '1', '-f', 'wav', '-y', wav_file]
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode != 0:
                raise Exception(f"FFmpeg error: {result.stderr}")
            
            # Transcribe
            wf = wave.open(wav_file, 'rb')
            recognizer = KaldiRecognizer(self.model, wf.getframerate())
            recognizer.SetWords(True)
            
            while True:
                data = wf.readframes(4000)
                if len(data) == 0:
                    break
                recognizer.AcceptWaveform(data)
            
            result_json = recognizer.FinalResult()
            result_data = json.loads(result_json)
            text = result_data.get('text', '').strip()
            
            # Response
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'text': text,
                'language': 'pl',
                'model': 'vosk-small-pl'
            }).encode())
            
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())
        
        finally:
            # Cleanup
            for f in [temp_audio, wav_file]:
                if os.path.exists(f):
                    os.unlink(f)
    
    def log_message(self, format, *args):
        pass

def main():
    if not VOSK_AVAILABLE:
        print("Vosk not available. Activate venv first.")
        return
    
    host = '127.0.0.1'
    port = 8081
    
    print(f"Starting Vosk STT server on {host}:{port}")
    print("Endpoints:")
    print(f"  GET  http://{host}:{port}/health")
    print(f"  POST http://{host}:{port}/transcribe")
    print("\nPress Ctrl+C to stop")
    
    server = HTTPServer((host, port), VoskSTTServer)
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()

if __name__ == "__main__":
    main()
EOF

chmod +x "$VOSK_SERVER"
print_status "Vosk server script created: $VOSK_SERVER"

# Step 8: OpenClaw configuration
echo ""
echo "=== Step 8: OpenClaw Configuration ==="
print_status "Configuring OpenClaw to use local LLM..."

# Create OpenClaw config snippet
CONFIG_SNIPPET="$MEMPHIS_HOME/.memphis/openclaw_config.json"

cat > "$CONFIG_SNIPPET" << 'EOF'
{
  "models": {
    "mode": "merge",
    "providers": {
      "ollama": {
        "baseUrl": "http://localhost:11434",
        "api": "openai-completions",
        "models": [
          {
            "id": "qwen3.5:0.8b",
            "name": "Qwen 3.5 Polish",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 32768,
            "maxTokens": 8192,
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            }
          },
          {
            "id": "phi4-mini:3.8b",
            "name": "Phi 4 Mini",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 131072,
            "maxTokens": 4096,
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0
            }
          }
        ]
      }
    }
  }
}
EOF

print_status "OpenClaw config snippet saved: $CONFIG_SNIPPET"
print_warning "Apply with: openclaw config merge $CONFIG_SNIPPET"

# Step 9: Create startup script
echo ""
echo "=== Step 9: Startup Script ==="
STARTUP_SCRIPT="$MEMPHIS_HOME/.memphis/start_memphis.sh"

cat > "$STARTUP_SCRIPT" << 'EOF'
#!/bin/bash
# /.memphis AI Stack Startup Script

set -e
echo "Starting /.memphis AI Stack..."

# Start Ollama if not running
if ! curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "Starting Ollama..."
    ollama serve > /home/memphis/.memphis/logs/ollama_$(date +%Y%m%d_%H%M%S).log 2>&1 &
    sleep 5
fi

# Start Vosk STT server
echo "Starting Vosk STT server..."
cd /home/memphis/.openclaw/workspace
./vosk-venv/bin/python vosk_server.py > /home/memphis/.memphis/logs/vosk_$(date +%Y%m%d_%H%M%S).log 2>&1 &

# Start OpenClaw gateway
echo "Starting OpenClaw gateway..."
openclaw gateway start

echo ""
echo "=== Services Running ==="
echo "Ollama LLM:      http://localhost:11434"
echo "Vosk STT:        http://127.0.0.1:8081"
echo "OpenClaw:        http://127.0.0.1:18789"
echo ""
echo "Check logs:      ~/.memphis/logs/"
EOF

chmod +x "$STARTUP_SCRIPT"
print_status "Startup script created: $STARTUP_SCRIPT"

# Step 10: Create monitoring script
echo ""
echo "=== Step 10: Monitoring Script ==="
MONITOR_SCRIPT="$MEMPHIS_HOME/.memphis/monitor_memphis.sh"

cat > "$MONITOR_SCRIPT" << 'EOF'
#!/bin/bash
# /.memphis AI Stack Monitoring

echo "=== /.memphis AI Stack Status ==="
echo ""

# Check Ollama
echo "1. Ollama LLM:"
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "   Status:  ✅ RUNNING"
    MODEL_COUNT=$(curl -s http://localhost:11434/api/tags | jq '.models | length')
    echo "   Models:  $MODEL_COUNT loaded"
else
    echo "   Status:  ❌ STOPPED"
fi

# Check Vosk STT
echo ""
echo "2. Vosk STT Server:"
if curl -s http://127.0.0.1:8081/health > /dev/null 2>&1; then
    echo "   Status:  ✅ RUNNING"
    HEALTH=$(curl -s http://127.0.0.1:8081/health | jq -r '.status')
    echo "   Health:  $HEALTH"
else
    echo "   Status:  ❌ STOPPED"
fi

# Check OpenClaw
echo ""
echo "3. OpenClaw Gateway:"
if openclaw gateway status 2>&1 | grep -q "running"; then
    echo "   Status:  ✅ RUNNING"
    PORT=$(openclaw gateway status 2>&1 | grep "port=" | cut -d= -f2 | cut -d')' -f1)
    echo "   Port:    $PORT"
else
    echo "   Status:  ❌ STOPPED"
fi

# Disk usage
echo ""
echo "4. Disk Usage:"
du -sh /home/memphis/.openclaw/workspace/vosk-models/ | awk '{print "   Vosk Models: "$1}'
du -sh /home/memphis/.ollama/models/ 2>/dev/null | awk '{print "   Ollama Models: "$1}'
du -sh /home/memphis/.memphis/logs/ 2>/dev/null | awk '{print "   Logs: "$1}'

echo ""
echo "=== Quick Tests ==="
echo "Test Ollama:    curl -s http://localhost:11434/api/generate -d '{\"model\":\"qwen3.5:0.8b\",\"prompt\":\"test\"}' | jq"
echo "Test Vosk:      curl -s http://127.0.0.1:8081/health"
echo "Test OpenClaw:  openclaw status"
EOF

chmod +x "$MONITOR_SCRIPT"
print_status "Monitoring script created: $MONITOR_SCRIPT"

# Step 11: Final instructions
echo ""
echo "=== SETUP COMPLETE ==="
echo ""
echo "📁 Files created:"
echo "  - Documentation:  $MEMPHIS_HOME/memphis/MEMPHIS_AI_STACK.md"
echo "  - Setup script:   $MEMPHIS_HOME/memphis/setup_memphis.sh"
echo "  - Startup:        $STARTUP_SCRIPT"
echo "  - Monitor:        $MONITOR_SCRIPT"
echo "  - Config:         $CONFIG_SNIPPET"
echo ""
echo "🚀