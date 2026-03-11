# Ollama Setup for Memphis v5 🧠

This guide configures Ollama for local embeddings/chat with Memphis v5.

Related docs: [PREREQUISITES.md](./PREREQUISITES.md) · [POST-INSTALLATION.md](./POST-INSTALLATION.md) · [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)

---

## 1) Install Ollama

### Option A — Official script (recommended)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Option B — Package manager (if available on your distro)

```bash
# Example only; package names may vary by distro
sudo apt-get install -y ollama
# or
sudo dnf install -y ollama
```

Verify:

```bash
ollama --version
```

Expected output:

```text
ollama version x.y.z
```

---

## 2) Configure systemd service

Create service file:

```bash
sudo tee /etc/systemd/system/ollama.service >/dev/null <<'UNIT'
[Unit]
Description=Ollama Service
After=network.target

[Service]
Type=simple
User=ollama
Group=ollama
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=3
Environment=OLLAMA_HOST=0.0.0.0:11434
# Optional tuning:
# Environment=OLLAMA_NUM_PARALLEL=2
# Environment=OLLAMA_MAX_LOADED_MODELS=2
# Environment=OLLAMA_KEEP_ALIVE=15m

[Install]
WantedBy=multi-user.target
UNIT
```

Create user/group if needed:

```bash
sudo useradd -r -s /bin/false -U ollama 2>/dev/null || true
```

Enable + start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ollama
sudo systemctl status ollama --no-pager
```

---

## 3) Model management

Pull recommended embedding model:

```bash
ollama pull nomic-embed-text
```

Optional chat model:

```bash
ollama pull llama3.1:8b
```

List models:

```bash
ollama list
```

Delete model:

```bash
ollama rm llama3.1:8b
```

---

## 4) GPU acceleration

### NVIDIA CUDA

- Install recent NVIDIA driver
- Install CUDA toolkit compatible with your driver
- Reboot and verify:

```bash
nvidia-smi
ollama ps
```

### AMD ROCm

- Install supported ROCm stack for your distro/GPU
- Verify GPU visibility:

```bash
rocminfo | head
ollama ps
```

⚠️ If GPU is not detected, Ollama falls back to CPU.

---

## 5) Performance tuning

Set env variables in service file or shell:

```bash
export OLLAMA_NUM_PARALLEL=2
export OLLAMA_MAX_LOADED_MODELS=2
export OLLAMA_KEEP_ALIVE=15m
```

Memory tips:

- ✅ Keep enough free RAM for loaded models
- ✅ Prefer one embedding model for stable latency
- ⚠️ Avoid oversubscribing model concurrency on low-memory hosts

---

## 6) Test Ollama installation

Health/API check:

```bash
curl -s http://127.0.0.1:11434/api/tags | jq '.models[].name' | head
```

Embed test:

```bash
curl -s http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"nomic-embed-text","prompt":"Memphis test"}' | jq '.embedding | length'
```

Expected output:

```text
<integer vector length, e.g. 768>
```

---

## 7) Troubleshooting Ollama issues

### Service won’t start

```bash
sudo systemctl status ollama --no-pager
sudo journalctl -u ollama -n 100 --no-pager
```

### Port conflict (11434 already in use)

```bash
sudo ss -ltnp | grep 11434 || true
```

### Model pull timeout

```bash
ollama pull nomic-embed-text
# retry with stable internet / proxy settings
```

### Slow inference

- Check RAM/CPU saturation (`top`, `htop`)
- Use smaller models
- Reduce concurrent sessions

For broader diagnostics: [TROUBLESHOOTING-DECISION-TREE.md](./TROUBLESHOOTING-DECISION-TREE.md)
