# /.memphis AI Stack - Secure Local Assistant

**Version:** 1.0 | **Date:** 2026-04-05 | **Status:** ACTIVE

## 🎯 ARCHITECTURE PHILOSOPHY

- **Sovereign Computing** - Full control over stack
- **Privacy by Design** - Minimal data exfiltration
- **Defense in Depth** - Multi-layered security
- **Local-First** - Cloud only when absolutely necessary

## 📦 CURRENT STACK STATUS

### ✅ LOCAL COMPONENTS (OPERATIONAL)

| Component      | Technology            | Size  | Security     | Status        |
| -------------- | --------------------- | ----- | ------------ | ------------- |
| **STT**        | Vosk (Polish model)   | 50MB  | 100% offline | ✅ RUNNING    |
| **LLM**        | Ollama + Qwen3.5:0.8b | 1GB   | 100% offline | ✅ CONFIGURED |
| **Embeddings** | Nomic-embed-text      | 274MB | 100% offline | ✅ INSTALLED  |

### ⚠️ CLOUD COMPONENTS (TO REPLACE)

| Component     | Current        | Target               | Priority |
| ------------- | -------------- | -------------------- | -------- |
| **TTS**       | ElevenLabs API | Piper TTS (local)    | HIGH     |
| **Search**    | Brave API      | Local RAG (ChromaDB) | HIGH     |
| **Transport** | Telegram       | Matrix/Signal (E2EE) | MEDIUM   |

### ❌ DEPRECATED (REMOVE)

| Component    | Reason         | Replacement  |
| ------------ | -------------- | ------------ |
| DeepSeek API | China, logging | Ollama local |
| Minimax API  | China, logging | Ollama local |
| OpenAI API   | USA, logging   | Ollama local |

## 🔧 TECHNICAL CONFIGURATION

### 1. VOSK STT (Local Polish Speech-to-Text)

```
Location: /home/memphis/.openclaw/workspace/vosk-models/vosk-model-small-pl-0.22
Virtual Env: /home/memphis/.openclaw/workspace/vosk-venv
Server: http://127.0.0.1:8081
Endpoints:
  - GET /health → {"status": "ok", "model_loaded": true}
  - POST /transcribe → {"text": "...", "language": "pl"}
```

### 2. OLLAMA LLM (Local Language Models)

```
Server: http://localhost:11434
Available Models:
  - qwen3.5:0.8b (1GB) - Multilingual, Polish support
  - phi4-mini:3.8b (2.5GB) - English optimized
  - nomic-embed-text (274MB) - Embeddings
  - granite3.2-vision (2.4GB) - Vision capabilities
```

### 3. OPENCLAW CONFIGURATION

```json
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
            "contextWindow": 32768,
            "maxTokens": 8192
          }
        ]
      }
    }
  },
  "messages": {
    "tts": {
      "auto": "always",
      "provider": "elevenlabs",
      "providers": {
        "elevenlabs": {
          "apiKey": "REDACTED",
          "voiceId": "pNInz6obpgDQGcFmaJgB",
          "modelId": "eleven_multilingual_v2"
        }
      }
    }
  },
  "tools": {
    "web": {
      "search": {
        "enabled": true,
        "provider": "brave",
        "brave": {
          "apiKey": "REDACTED"
        }
      }
    }
  }
}
```

## 🛡️ SECURITY MEASURES

### Network Layer

- **Firewall**: Only necessary ports open
- **VPN**: WireGuard/Tailscale for remote access
- **Isolation**: Docker containers where possible

### Application Layer

- **Input Sanitization**: Regex filtering of audio transcripts
- **Rate Limiting**: Per-user request limits
- **Audit Logging**: All operations logged locally

### Data Layer

- **Encryption**: LUKS for data at rest
- **Backups**: Regular encrypted backups
- **Retention**: 30-day log retention policy

## 🚀 ROADMAP

### Phase 1: Localization (Week 1-2)

- [ ] Replace ElevenLabs TTS with Piper TTS
- [ ] Implement local RAG with ChromaDB
- [ ] Add audio input sanitization

### Phase 2: Secure Transport (Week 3-4)

- [ ] Deploy Matrix server (self-hosted)
- [ ] Configure OpenClaw Matrix plugin
- [ ] Migrate from Telegram to Matrix

### Phase 3: Production Hardening (Week 5-6)

- [ ] Dockerize all components
- [ ] Implement monitoring/alerting
- [ ] Create disaster recovery plan

### Phase 4: Advanced Features (Week 7-8)

- [ ] Multi-modal capabilities (vision)
- [ ] Real-time voice conversations
- [ ] Plugin ecosystem

## 📊 PERFORMANCE METRICS

### Hardware Requirements

| Component  | Min RAM | Optimal RAM | Storage   |
| ---------- | ------- | ----------- | --------- |
| Vosk STT   | 100MB   | 256MB       | 50MB      |
| Ollama LLM | 2GB     | 8GB         | 5GB       |
| RAG System | 1GB     | 4GB         | 10GB+     |
| **Total**  | **3GB** | **12GB**    | **15GB+** |

### Response Times

- STT Transcription: 1-3 seconds (CPU)
- LLM Inference: 2-5 seconds (CPU)
- TTS Generation: 1-2 seconds (CPU)
- **Total**: 4-10 seconds per interaction

## 🔄 DEPLOYMENT SCRIPTS

### 1. Initial Setup

```bash
#!/bin/bash
# setup_memphis.sh

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Install Vosk
python3 -m venv ~/.openclaw/workspace/vosk-venv
~/.openclaw/workspace/vosk-venv/bin/pip install vosk soundfile numpy

# Download Polish model
mkdir -p ~/.openclaw/workspace/vosk-models
cd ~/.openclaw/workspace/vosk-models
wget https://alphacephei.com/vosk/models/vosk-model-small-pl-0.22.zip
unzip vosk-model-small-pl-0.22.zip
rm vosk-model-small-pl-0.22.zip

# Pull LLM models
ollama pull qwen3.5:0.8b
ollama pull nomic-embed-text:latest
```

### 2. Start Services

```bash
#!/bin/bash
# start_memphis.sh

# Start Ollama
ollama serve &

# Start Vosk STT server
cd /home/memphis/.openclaw/workspace
./vosk-venv/bin/python create_vosk_server.py &

# Start OpenClaw gateway
openclaw gateway start
```

### 3. Security Hardening

```bash
#!/bin/bash
# harden_memphis.sh

# Firewall rules
sudo ufw allow 11434/tcp  # Ollama
sudo ufw allow 8081/tcp   # Vosk STT
sudo ufw allow 18789/tcp  # OpenClaw
sudo ufw enable

# Audit logging
sudo auditctl -w /home/memphis/.openclaw/ -p wa -k openclaw_audit
sudo auditctl -w /home/memphis/.memphis/ -p wa -k memphis_audit
```

## 🆘 TROUBLESHOOTING

### Common Issues

1. **Vosk server not starting**

   ```bash
   # Check dependencies
   ./vosk-venv/bin/python -c "import vosk; print('OK')"

   # Check model path
   ls -la /home/memphis/.openclaw/workspace/vosk-models/
   ```

2. **Ollama models not loading**

   ```bash
   # Check Ollama service
   systemctl --user status ollama

   # List available models
   curl http://localhost:11434/api/tags | jq
   ```

3. **OpenClaw not using local LLM**

   ```bash
   # Check config
   openclaw config get models.providers.ollama

   # Test Ollama directly
   curl http://localhost:11434/api/generate -d '{"model": "qwen3.5:0.8b", "prompt": "test"}'
   ```

## 📞 CONTACT & SUPPORT

### Internal

- **Maintainer**: Memphis
- **Backup**: [To be assigned]
- **On-call**: [Rotation schedule]

### External Resources

- **Ollama Docs**: https://ollama.com
- **Vosk Docs**: https://alphacephei.com/vosk
- **OpenClaw Docs**: https://docs.openclaw.ai
- **Matrix**: https://matrix.org

### Emergency Procedures

1. **Service Outage**: Restart via `systemctl --user restart ollama`
2. **Security Breach**: Isolate network, preserve logs, contact maintainer
3. **Data Loss**: Restore from latest encrypted backup

---

**Last Updated**: 2026-04-05  
**Next Review**: 2026-05-05  
**Document ID**: MEMPHIS-AI-STACK-v1.0
