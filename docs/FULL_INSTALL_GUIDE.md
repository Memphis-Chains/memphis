# Memphis Ecosystem — Complete Installation Guide

# Memphis Ekosystem — Kompletny Przewodnik Instalacyjny

---

> **What is this?** / **Co to jest?**
>
> Memphis is a three-layer system: a **memory core** (Memphis), a **control plane** (MemphisOS), and an **AI gateway** (OpenClaw). Together they give you a self-hosted, cryptographically auditable AI assistant with persistent memory.
>
> Memphis to trójwarstwowy system: **rdzeń pamięci** (Memphis), **warstwa kontrolna** (MemphisOS) i **brama AI** (OpenClaw). Razem tworzą samodzielnie hostowanego, kryptograficznie audytowalnego asystenta AI z trwałą pamięcią.

---

## Table of Contents / Spis treści

1. [Architecture Overview / Przegląd architektury](#1-architecture-overview--przegląd-architektury)
2. [System Requirements / Wymagania systemowe](#2-system-requirements--wymagania-systemowe)
3. [Layer 0: Base Tools / Warstwa 0: Narzędzia bazowe](#3-layer-0-base-tools--warstwa-0-narzędzia-bazowe)
4. [Layer 1: Memphis — Memory Core / Rdzeń pamięci](#4-layer-1-memphis--memory-core--rdzeń-pamięci)
5. [Layer 2: MemphisOS — Control Plane / Warstwa kontrolna](#5-layer-2-memphisos--control-plane--warstwa-kontrolna)
6. [Layer 3: OpenClaw — AI Gateway / Brama AI](#6-layer-3-openclaw--ai-gateway--brama-ai)
7. [First Conversation / Pierwsza rozmowa](#7-first-conversation--pierwsza-rozmowa)
8. [Alternative: Claude Code / Codex CLI](#8-alternative-claude-code--codex-cli)
9. [Docker Deployment / Wdrożenie Docker](#9-docker-deployment--wdrożenie-docker)
10. [Troubleshooting / Rozwiązywanie problemów](#10-troubleshooting--rozwiązywanie-problemów)
11. [Security Notes / Uwagi bezpieczeństwa](#11-security-notes--uwagi-bezpieczeństwa)

---

## 1. Architecture Overview / Przegląd architektury

```
┌─────────────────────────────────────────────────────────┐
│                    USER / UŻYTKOWNIK                     │
│              Telegram · Discord · CLI · API              │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              LAYER 3: OpenClaw (Gateway)                 │
│   AI conversations · Multi-channel · LLM routing        │
│   Port: 4000  ·  Repo: MemphisOS-OpenClaw               │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP (recall/store)
┌────────────────────────▼────────────────────────────────┐
│              LAYER 2: MemphisOS (Control Plane)          │
│   Policy · Vault · Audit · App management · MCP         │
│   Port: 3000  ·  Repo: MemphisOS                        │
└────────────────────────┬────────────────────────────────┘
                         │ NAPI bridge (in-process)
┌────────────────────────▼────────────────────────────────┐
│              LAYER 1: Memphis (Rust Core)                │
│   Blockchain chains · SHA-256 hashing · Ed25519 sigs    │
│   Deterministic replay · Embeddings · Encrypted vault   │
│   Crates: memphis-core · memphis-vault · memphis-embed  │
└─────────────────────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│              LAYER 0: System Dependencies                │
│   Node.js 22+ · Rust stable · Ollama · SQLite · git     │
└─────────────────────────────────────────────────────────┘
```

**EN:** Install from bottom to top. Each layer depends on the one below it.

**PL:** Instaluj od dołu do góry. Każda warstwa zależy od warstwy poniżej.

---

## 2. System Requirements / Wymagania systemowe

| Component / Komponent | Minimum                                | Recommended / Zalecane                |
| --------------------- | -------------------------------------- | ------------------------------------- |
| OS                    | Linux (Ubuntu 22.04+), macOS 13+, WSL2 | Ubuntu 24.04 LTS                      |
| RAM                   | 4 GB                                   | 16 GB+ (for local LLM)                |
| Disk / Dysk           | 5 GB                                   | 50 GB+ (for model weights)            |
| CPU                   | x86_64 or ARM64                        | 4+ cores                              |
| GPU (optional)        | —                                      | NVIDIA with CUDA (for fast local LLM) |
| Network / Sieć        | Required for install                   | Optional after install (local-first)  |

---

## 3. Layer 0: Base Tools / Warstwa 0: Narzędzia bazowe

### 3.1 git + curl

**Ubuntu / Debian:**

```bash
sudo apt update && sudo apt install -y git curl build-essential
```

**Fedora / RHEL:**

```bash
sudo dnf install -y git curl gcc gcc-c++ make
```

**macOS:**

```bash
xcode-select --install
brew install git curl
```

**Verify / Sprawdź:**

```bash
git --version    # >= 2.30
curl --version   # any recent version
```

---

### 3.2 Node.js (v22+)

**EN:** Memphis requires Node.js 22 or newer. The install script asks for v24, but v22 works for all components.

**PL:** Memphis wymaga Node.js 22 lub nowszego. Skrypt instalacyjny prosi o v24, ale v22 działa ze wszystkimi komponentami.

**Ubuntu / Debian:**

```bash
# Option A: NodeSource (recommended / zalecane)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Option B: nvm (if you manage multiple Node versions)
# Opcja B: nvm (jeśli zarządzasz wieloma wersjami Node)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
```

**macOS:**

```bash
brew install node@22
```

**Verify / Sprawdź:**

```bash
node --version   # v22.x.x or higher / lub wyższe
npm --version    # 10.x or higher / lub wyższe
```

---

### 3.3 Rust (stable)

**EN:** The Rust core compiles cryptographic primitives (Ed25519 signatures, SHA-256 chains, encrypted vault). Install the stable toolchain.

**PL:** Rdzeń Rust kompiluje prymitywy kryptograficzne (podpisy Ed25519, łańcuchy SHA-256, szyfrowany vault). Zainstaluj stabilny toolchain.

**All platforms / Wszystkie platformy:**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

**Verify / Sprawdź:**

```bash
rustc --version   # rustc 1.80+ (stable)
cargo --version   # cargo 1.80+
```

> **Tip / Wskazówka:** If you already have Rust nightly, switch to stable:
> Jeśli masz już Rust nightly, przełącz na stable:
>
> ```bash
> rustup default stable
> ```

---

### 3.4 Ollama (Local LLM + Embeddings)

**EN:** Ollama provides local AI inference without sending data to the cloud. It's the default provider for both MemphisOS embeddings and OpenClaw conversations.

**PL:** Ollama zapewnia lokalne wnioskowanie AI bez wysyłania danych do chmury. Jest domyślnym dostawcą zarówno dla embeddingów MemphisOS, jak i rozmów OpenClaw.

**Install / Instalacja:**

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

**Pull required models / Pobierz wymagane modele:**

```bash
# Embedding model (required for Memphis memory search)
# Model embeddingów (wymagany do przeszukiwania pamięci Memphis)
ollama pull nomic-embed-text

# Conversation model (required for OpenClaw chat)
# Model konwersacyjny (wymagany do rozmów OpenClaw)
# Choose ONE based on your hardware / Wybierz JEDEN w zależności od sprzętu:

ollama pull qwen3.5:2b       # Light — 2 GB RAM, fast, good for testing
                              # Lekki — 2 GB RAM, szybki, dobry do testów

# ollama pull qwen2.5:7b     # Medium — 5 GB RAM, good quality
#                              # Średni — 5 GB RAM, dobra jakość

# ollama pull qwen2.5:32b    # Heavy — 20 GB RAM, high quality
#                              # Ciężki — 20 GB RAM, wysoka jakość
```

**Verify / Sprawdź:**

```bash
ollama --version              # 0.5+
ollama list                   # should show pulled models / powinno pokazać pobrane modele
```

**NVIDIA GPU users / Użytkownicy GPU NVIDIA:**

```bash
# Ollama auto-detects CUDA. Verify GPU is used:
# Ollama automatycznie wykrywa CUDA. Sprawdź czy GPU jest używane:
nvidia-smi                    # should show ollama process / powinno pokazać proces ollama
```

> **No GPU? / Brak GPU?** Ollama works on CPU too, just slower. The `qwen3.5:2b` model runs well even on CPU-only machines.
>
> Ollama działa też na CPU, tylko wolniej. Model `qwen3.5:2b` działa dobrze nawet na maszynach bez GPU.

---

### 3.5 Layer 0 — Final Check / Końcowa weryfikacja

Run this to confirm everything is ready / Uruchom to aby potwierdzić gotowość:

```bash
echo "=== Layer 0 Check / Warstwa 0 Sprawdzenie ==="
echo "git:    $(git --version 2>/dev/null || echo 'MISSING / BRAK')"
echo "node:   $(node --version 2>/dev/null || echo 'MISSING / BRAK')"
echo "npm:    $(npm --version 2>/dev/null || echo 'MISSING / BRAK')"
echo "rustc:  $(rustc --version 2>/dev/null || echo 'MISSING / BRAK')"
echo "cargo:  $(cargo --version 2>/dev/null || echo 'MISSING / BRAK')"
echo "ollama: $(ollama --version 2>/dev/null || echo 'MISSING / BRAK (optional)')"
```

All except Ollama must show a version. Ollama is optional (you can use Anthropic API instead).

Wszystkie oprócz Ollama muszą pokazać wersję. Ollama jest opcjonalna (zamiast tego możesz użyć API Anthropic).

---

## 4. Layer 1: Memphis — Memory Core / Rdzeń pamięci

### 4.1 Clone / Klonowanie

```bash
cd ~
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
```

### 4.2 Install dependencies / Instalacja zależności

```bash
npm install
```

### 4.3 Build (TypeScript + Rust NAPI bridge)

**EN:** This compiles the Rust cryptographic core and links it to Node.js via NAPI. First build takes 2-5 minutes.

**PL:** To kompiluje kryptograficzny rdzeń Rust i łączy go z Node.js przez NAPI. Pierwsza kompilacja trwa 2-5 minut.

```bash
npm run build
```

**What happens / Co się dzieje:**

1. `cargo build` compiles Rust crates (memphis-core, memphis-vault, memphis-embed, memphis-napi)
2. NAPI bridge generates `memphis-napi.node` binary
3. TypeScript compiles to `dist/`

### 4.4 Configure environment / Konfiguracja środowiska

```bash
cp .env.example .env
```

**Edit `.env` / Edytuj `.env`:**

```bash
# Minimal working config / Minimalna działająca konfiguracja:
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
DEFAULT_PROVIDER=ollama
DATABASE_URL=file:./data/memphis-v5.db
RUST_CHAIN_ENABLED=false
RUST_EMBED_MODE=ollama
RUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434/api/embeddings
RUST_EMBED_PROVIDER_MODEL=nomic-embed-text
```

> **MEMPHIS_API_TOKEN:** Leave empty for development. Set a strong random string for production.
>
> Zostaw puste na czas developmentu. Ustaw silny losowy ciąg znaków w produkcji.

### 4.5 Verify / Weryfikacja

```bash
# Health check (no server needed)
# Sprawdzenie zdrowia (serwer nie jest wymagany)
npm run -s cli -- health --json

# Full diagnostics / Pełna diagnostyka
npm run -s cli -- doctor --json
```

**Expected output / Oczekiwany wynik:**

```json
{
  "status": "ok",
  "service": "memphis-v5"
}
```

### 4.6 Start Memphis server / Uruchom serwer Memphis

```bash
npm run dev
```

**EN:** Memphis is now running on `http://127.0.0.1:3000`. Keep this terminal open. Open a new terminal for the next steps.

**PL:** Memphis działa teraz na `http://127.0.0.1:3000`. Zostaw ten terminal otwarty. Otwórz nowy terminal do następnych kroków.

**Verify the server is responding / Sprawdź czy serwer odpowiada:**

```bash
curl -s http://127.0.0.1:3000/health | head -1
```

### 4.7 Run Rust tests (optional but recommended) / Testy Rust (opcjonalne, ale zalecane)

```bash
npm run test:rust
```

All 130 tests should pass. This verifies your Rust core, cryptographic signing, chain integrity, and vault encryption are working correctly.

Wszystkie 130 testów powinno przejść. To weryfikuje rdzeń Rust, podpisy kryptograficzne, integralność łańcucha i szyfrowanie vault.

---

## 5. Layer 2: MemphisOS — Control Plane / Warstwa kontrolna

### 5.1 Clone / Klonowanie

```bash
cd ~
git clone https://github.com/Memphis-Chains/MemphisOS.git
cd MemphisOS
```

### 5.2 Install and build / Instalacja i kompilacja

```bash
npm ci
npm run build
```

### 5.3 Configure environment / Konfiguracja środowiska

```bash
cp .env.example .env
```

**Edit `.env` — key settings / Edytuj `.env` — kluczowe ustawienia:**

```bash
NODE_ENV=development
HOST=127.0.0.1
PORT=3000                    # Same port as Memphis — run one at a time or change this
                             # Ten sam port co Memphis — uruchamiaj jedno naraz lub zmień
LOG_LEVEL=info
DEFAULT_PROVIDER=ollama
DATABASE_URL=file:./data/memphis-v5.db
RUST_CHAIN_ENABLED=false
RUST_EMBED_MODE=ollama
RUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434/api/embeddings
RUST_EMBED_PROVIDER_MODEL=nomic-embed-text

# Vault (will be initialized later / zostanie zainicjalizowany później)
MEMPHIS_VAULT_PEPPER=
MEMPHIS_VAULT_ENTRIES_PATH=./data/vault-entries.json

# Security policy / Polityka bezpieczeństwa
GATEWAY_EXEC_RESTRICTED_MODE=true
GATEWAY_EXEC_ALLOWLIST=echo,pwd,ls,whoami,date,uptime
```

### 5.4 Initialize the vault / Inicjalizacja skarbca

**EN:** The vault stores encrypted secrets (API keys, tokens). You'll need a passphrase you can remember.

**PL:** Vault przechowuje zaszyfrowane sekrety (klucze API, tokeny). Będziesz potrzebować hasła, które zapamiętasz.

```bash
npm run -s cli -- vault init \
  --passphrase 'your-strong-passphrase-here' \
  --recovery-question 'Your recovery question' \
  --recovery-answer 'your-recovery-answer'
```

> **Important / Ważne:** Write down your passphrase somewhere safe. If you lose it, you'll need the recovery question/answer.
>
> Zapisz hasło w bezpiecznym miejscu. Jeśli je stracisz, będziesz potrzebować pytania/odpowiedzi odzyskiwania.

### 5.5 Onboarding wizard (optional) / Kreator konfiguracji (opcjonalny)

```bash
npm run -s cli -- onboarding wizard --interactive
```

This walks you through configuration interactively. / To przeprowadzi Cię interaktywnie przez konfigurację.

### 5.6 Verify / Weryfikacja

```bash
npm run -s cli -- health --json
npm run -s cli -- doctor --json
```

### 5.7 Run tests / Uruchom testy

```bash
# TypeScript tests / Testy TypeScript
npm run test:ts

# Rust core tests / Testy rdzenia Rust
npm run test:rust

# Operations gate tests / Testy bram operacyjnych
npm run test:ops-artifacts
```

### 5.8 Start MemphisOS / Uruchom MemphisOS

```bash
npm run dev
```

> **Note / Uwaga:** If Memphis (Layer 1) is running on port 3000, either stop it first or change MemphisOS port in `.env` to 3001.
>
> Jeśli Memphis (Warstwa 1) działa na porcie 3000, albo go zatrzymaj, albo zmień port MemphisOS w `.env` na 3001.

---

## 6. Layer 3: OpenClaw — AI Gateway / Brama AI

**EN:** OpenClaw is the user-facing layer. It connects to Telegram, Discord, or exposes an API. It talks to an LLM (Ollama or Anthropic Claude) and stores/recalls memories through Memphis.

**PL:** OpenClaw to warstwa skierowana do użytkownika. Łączy się z Telegramem, Discordem lub udostępnia API. Rozmawia z LLM (Ollama lub Anthropic Claude) i zapisuje/przywołuje wspomnienia przez Memphis.

### 6.1 Clone / Klonowanie

```bash
cd ~
git clone https://github.com/Memphis-Chains/MemphisOS-OpenClaw.git openclaw
cd openclaw
```

### 6.2 Install and build / Instalacja i kompilacja

```bash
npm install
npm run build
```

### 6.3 Configure environment / Konfiguracja środowiska

```bash
cp .env.example .env
```

**Edit `.env` / Edytuj `.env`:**

#### Option A: Local Ollama (free, private) / Opcja A: Lokalna Ollama (darmowa, prywatna)

```bash
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:2b
OLLAMA_THINK=false
```

#### Option B: Anthropic Claude (cloud, paid) / Opcja B: Anthropic Claude (chmura, płatny)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
ANTHROPIC_MODEL=claude-sonnet-4-6
```

#### Memphis connection / Połączenie z Memphis

```bash
# Point to your running Memphis instance
# Wskaż na działającą instancję Memphis
MEMPHIS_API_URL=http://localhost:3000
MEMPHIS_API_TOKEN=                    # must match MEMPHIS_API_TOKEN in Memphis .env
                                      # musi pasować do MEMPHIS_API_TOKEN w .env Memphis
```

#### Channel setup / Konfiguracja kanałów

**At least ONE channel is required / Przynajmniej JEDEN kanał jest wymagany:**

##### Telegram:

1. Open Telegram, find `@BotFather` / Otwórz Telegram, znajdź `@BotFather`
2. Send `/newbot`, follow instructions / Wyślij `/newbot`, postępuj zgodnie z instrukcjami
3. Copy the token / Skopiuj token

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
```

##### Discord:

1. Go to https://discord.com/developers/applications
2. Create New Application → Bot → Copy token / Utwórz nową aplikację → Bot → Skopiuj token
3. Enable MESSAGE CONTENT intent / Włącz uprawnienie MESSAGE CONTENT
4. Invite bot to your server / Zaproś bota na swój serwer

```bash
DISCORD_BOT_TOKEN=your-discord-token
```

### 6.4 Start OpenClaw / Uruchom OpenClaw

**EN:** Make sure Memphis (Layer 1) is running first! OpenClaw needs it for memory.

**PL:** Upewnij się, że Memphis (Warstwa 1) jest uruchomiony! OpenClaw potrzebuje go do pamięci.

```bash
npm run dev
```

**Expected output / Oczekiwany wynik:**

```
[info] OpenClaw gateway starting...
[info] LLM provider: ollama (qwen3.5:2b)
[info] Memphis memory: connected (http://localhost:3000)
[info] Telegram bot: online
```

### 6.5 Verify / Weryfikacja

```bash
npm run test
npm run typecheck
npm run lint
```

---

## 7. First Conversation / Pierwsza rozmowa

### With Telegram / Przez Telegram

1. Open Telegram / Otwórz Telegram
2. Find your bot by the username you gave it / Znajdź swojego bota po nazwie, którą mu nadałeś
3. Send: `Hello, are you alive?` / Wyślij: `Cześć, żyjesz?`
4. The bot should respond! / Bot powinien odpowiedzieć!

### With Discord / Przez Discord

1. Go to the server where you invited the bot / Przejdź na serwer, na który zaprosiłeś bota
2. Send a message mentioning the bot: `@YourBot Hello!` / Wyślij wiadomość wspominając bota
3. The bot should respond! / Bot powinien odpowiedzieć!

### Verify memory is working / Sprawdź czy pamięć działa

After your first conversation, check that Memphis stored the memory:

Po pierwszej rozmowie sprawdź, czy Memphis zapisał pamięć:

```bash
# Query Memphis API directly / Odpytaj API Memphis bezpośrednio
curl -s http://localhost:3000/health
```

---

## 8. Alternative: Claude Code / Codex CLI

**EN:** Instead of (or alongside) OpenClaw, you can use Memphis with Claude Code or Codex CLI for code-focused AI assistance.

**PL:** Zamiast (lub obok) OpenClaw, możesz używać Memphis z Claude Code lub Codex CLI do pomocy AI zorientowanej na kod.

### Claude Code

```bash
# Install Claude Code / Instalacja Claude Code
npm install -g @anthropic-ai/claude-code

# Run in any project directory / Uruchom w dowolnym katalogu projektu
claude
```

Claude Code reads `CLAUDE.md` files in your repo for project context. Memphis provides the persistent memory layer beneath it.

Claude Code czyta pliki `CLAUDE.md` w Twoim repozytorium jako kontekst projektu. Memphis zapewnia trwałą warstwę pamięci pod spodem.

### Codex CLI (OpenAI)

```bash
npm install -g @openai/codex
codex
```

---

## 9. Docker Deployment / Wdrożenie Docker

**EN:** For production or quick testing without installing dependencies locally.

**PL:** Do produkcji lub szybkich testów bez instalowania zależności lokalnie.

### Memphis + Ollama (docker-compose)

```bash
cd ~/memphis

# Start Memphis + Ollama / Uruchom Memphis + Ollama
docker compose --profile ollama up -d

# Check logs / Sprawdź logi
docker compose logs -f memphis
```

### MemphisOS (standalone Docker)

```bash
cd ~/MemphisOS

# Build image / Zbuduj obraz
docker build -t memphisos .

# Run / Uruchom
docker run -d \
  --name memphisos \
  -p 3000:3000 \
  -v memphisos-data:/home/memphis/.memphis \
  --env-file .env \
  memphisos
```

### OpenClaw (standalone Docker)

```bash
cd ~/openclaw
docker build -t openclaw .
docker run -d \
  --name openclaw \
  --env-file .env \
  --network host \
  openclaw
```

---

## 10. Troubleshooting / Rozwiązywanie problemów

### Build fails / Kompilacja się nie udaje

| Problem          | Solution / Rozwiązanie                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `npm ci` fails   | Check Node.js version: `node --version` (need 22+). Sprawdź wersję Node.js.                                   |
| Rust build fails | Run `rustup default stable && rustup update`. Uruchom `rustup default stable && rustup update`.               |
| NAPI link error  | Delete `node_modules/` and run `npm install && npm run build` again. Usuń `node_modules/` i uruchom ponownie. |
| `cc` not found   | Install build tools: `sudo apt install build-essential`. Zainstaluj narzędzia kompilacji.                     |

### Runtime errors / Błędy runtime

| Problem                       | Solution / Rozwiązanie                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Port 3000 in use              | Change PORT in `.env` or stop the other process: `lsof -i :3000`. Zmień PORT w `.env` lub zatrzymaj inny proces. |
| Ollama connection refused     | Start Ollama: `ollama serve` (or `systemctl start ollama`). Uruchom Ollama.                                      |
| Memphis memory not connecting | Check MEMPHIS_API_URL in OpenClaw `.env`. Verify Memphis is running: `curl http://localhost:3000/health`.        |
| `model not found`             | Pull the model: `ollama pull qwen3.5:2b`. Pobierz model.                                                         |
| Telegram bot not responding   | Check TELEGRAM_BOT_TOKEN in `.env`. Only one process can use a bot token. Sprawdź token.                         |

### Diagnostic commands / Komendy diagnostyczne

```bash
# Memphis health / Zdrowie Memphis
cd ~/memphis && npm run -s cli -- health --json

# MemphisOS full diagnostics / Pełna diagnostyka MemphisOS
cd ~/MemphisOS && npm run -s cli -- doctor --json

# Check what's listening on ports / Sprawdź co nasłuchuje na portach
ss -tlnp | grep -E '3000|4000|11434'

# Ollama status / Status Ollama
ollama list
curl -s http://localhost:11434/api/tags | head -20

# Check logs / Sprawdź logi
journalctl --user -u memphis -f    # if running as systemd service
```

---

## 11. Security Notes / Uwagi bezpieczeństwa

### Files that must NEVER be committed / Pliki, które NIGDY nie powinny być commitowane

```
.env                    # Contains tokens and keys / Zawiera tokeny i klucze
data/                   # SQLite databases, vault / Bazy SQLite, vault
*.key, *.pem            # Private keys / Klucze prywatne
vault-entries.json      # Encrypted secrets / Zaszyfrowane sekrety
```

All three repos have `.gitignore` configured to exclude these, but always verify before pushing.

Wszystkie trzy repozytoria mają skonfigurowany `.gitignore` aby je wykluczać, ale zawsze weryfikuj przed push.

### Production checklist / Lista kontrolna produkcji

- [ ] Set strong `MEMPHIS_API_TOKEN` in both Memphis and OpenClaw `.env` / Ustaw silny token w obu plikach `.env`
- [ ] Set `NODE_ENV=production`
- [ ] Initialize vault with strong passphrase / Zainicjalizuj vault silnym hasłem
- [ ] Enable `RUST_CHAIN_ENABLED=true` for cryptographic chain integrity / Włącz integralność łańcucha
- [ ] Set `GATEWAY_EXEC_RESTRICTED_MODE=true` (default)
- [ ] Run behind reverse proxy (nginx/caddy) with TLS / Uruchom za reverse proxy z TLS
- [ ] Set up systemd services for auto-restart / Skonfiguruj usługi systemd do auto-restartu

---

## Quick Reference / Szybka ściągawka

### Start everything (development) / Uruchom wszystko (development)

Open three terminals / Otwórz trzy terminale:

```bash
# Terminal 1: Ollama (if not running as service)
ollama serve

# Terminal 2: Memphis (memory core)
cd ~/memphis && npm run dev

# Terminal 3: OpenClaw (AI gateway)
cd ~/openclaw && npm run dev
```

### Stop everything / Zatrzymaj wszystko

```bash
# Ctrl+C in each terminal, or:
# Ctrl+C w każdym terminalu, lub:
pkill -f "tsx.*index.ts"    # stops all dev servers / zatrzymuje wszystkie serwery dev
```

### Useful paths / Przydatne ścieżki

| What / Co        | Path / Ścieżka                        |
| ---------------- | ------------------------------------- |
| Memphis data     | `~/memphis/data/`                     |
| MemphisOS data   | `~/MemphisOS/data/`                   |
| Ollama models    | `~/.ollama/models/`                   |
| Memphis config   | `~/memphis/.env`                      |
| MemphisOS config | `~/MemphisOS/.env`                    |
| OpenClaw config  | `~/openclaw/.env`                     |
| Vault secrets    | `~/MemphisOS/data/vault-entries.json` |
| Chain data       | `~/memphis/data/chains/`              |
| SQLite DB        | `~/memphis/data/memphis-v5.db`        |

---

**△⬡◈ Memphis Ecosystem — Local-First AI with Cryptographic Memory**

**△⬡◈ Ekosystem Memphis — Lokalne AI z Kryptograficzną Pamięcią**
