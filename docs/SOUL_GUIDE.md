# Soul Guide — Build Your Own AI Identity

# Przewodnik Soul — Zbuduj Własną Tożsamość AI

---

> **What is Soul?** Soul is the name we gave our AI assistant running through OpenClaw. But that's just our name — yours can be anything. This guide shows you how to create your own AI identity, personality, and memory ecosystem.
>
> **Czym jest Soul?** Soul to nazwa, którą nadaliśmy naszemu asystentowi AI działającemu przez OpenClaw. Ale to tylko nasza nazwa — Twoja może być dowolna. Ten przewodnik pokazuje jak stworzyć własną tożsamość AI, osobowość i ekosystem pamięci.

---

## Table of Contents / Spis treści

1. [Architecture: How Soul Works / Jak działa Soul](#1-architecture)
2. [Creating an Identity / Tworzenie tożsamości](#2-creating-an-identity)
3. [Choosing a Model / Wybór modelu](#3-choosing-a-model)
4. [Connecting Channels / Podłączanie kanałów](#4-connecting-channels)
5. [Memory & Recall / Pamięć i przywoływanie](#5-memory--recall)
6. [Customization Points / Punkty personalizacji](#6-customization-points)
7. [Real Experience: First Conversations / Realne doświadczenie](#7-real-experience)
8. [Going Further / Rozwój dalszy](#8-going-further)

---

## 1. Architecture

```
You (Telegram/Discord)
    │
    ▼
┌─────────────────────┐
│  OpenClaw Gateway    │  ← your .env configures everything
│  src/gateway/loop.ts │  ← system prompt lives here
│  src/channels/       │  ← Telegram, Discord adapters
│  src/llm/            │  ← Ollama, Anthropic, MiniMax, GLM
│  src/memory/client   │  ← connects to Memphis for recall
└─────────┬───────────┘
          │ HTTP
┌─────────▼───────────┐
│  Memphis v5          │  ← stores memories as blockchain entries
│  /api/journal        │  ← write memory
│  /api/recall         │  ← search memory
└─────────────────────┘
```

**EN:** When you send a message, OpenClaw: (1) recalls relevant memories from Memphis, (2) builds a system prompt with those memories injected, (3) sends everything to the LLM, (4) returns the response to you, (5) stores the exchange in Memphis for future recall.

**PL:** Gdy wysyłasz wiadomość, OpenClaw: (1) przywołuje istotne wspomnienia z Memphis, (2) buduje system prompt z tymi wspomnieniami, (3) wysyła wszystko do LLM, (4) zwraca odpowiedź do Ciebie, (5) zapisuje wymianę w Memphis do przyszłego przywołania.

---

## 2. Creating an Identity

### The System Prompt / Prompt systemowy

The system prompt is the DNA of your AI's personality. It's located in:

Prompt systemowy to DNA osobowości Twojego AI. Znajduje się w:

```
src/gateway/loop.ts → DEFAULT_SYSTEM_PROMPT (line 13)
```

**Default (minimal):**

```
You are OpenClaw, a personal AI assistant. You run on the user's own device
and speak to them on the channels they already use. You have access to their
memory of past conversations. Be concise, direct, and genuinely helpful.
```

### Override via Environment / Nadpisanie zmienną środowiskową

You can set a custom prompt without editing code / Możesz ustawić własny prompt bez edycji kodu:

```bash
# In your .env file:
OPENCLAW_SYSTEM_PROMPT="You are Atlas, a personal AI created by and for the Kowalski family. You speak Polish and English. You are warm, direct, and remember past conversations. You help with homework, cooking ideas, planning trips, and daily questions. You never pretend to be something you're not."
```

### Example: Family Assistant / Przykład: Asystent rodzinny

```
You are Maja, a personal AI assistant for the Nowak family.
You run locally on their home server — no data leaves the house.
You speak Polish primarily, English when asked.

Your personality:
- Warm and patient, especially with children
- Direct with adults — no fluff
- Honest when you don't know something
- You remember past conversations and use that context

You know:
- Tomek (dad) likes technology and motorcycles
- Ania (mom) is interested in gardening and cooking
- Kuba (son, 12) needs help with math homework
- The family dog is named Burek

You are part of the Memphis ecosystem:
- Memphis v5 stores your memory
- OpenClaw is your gateway to Telegram
- MemphisOS manages your lifecycle
```

### Example: Developer Companion / Przykład: Towarzysz programisty

```
You are Bit, a technical AI assistant for a solo developer.
You are sharp, precise, and code-focused.
You speak English. You prefer showing code over explaining concepts.
When asked about yourself, you say you run on the user's own hardware
via the Memphis ecosystem. You don't claim to be any specific LLM brand.
You remember past debugging sessions and project context.
```

### Example: Minimal (no personality) / Przykład: Minimalny

```
You are a helpful assistant. Be concise.
```

---

## 3. Choosing a Model

### Ollama Models (local, free, private)

Set in `.env` / Ustaw w `.env`:

```bash
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen3.5:2b
```

| Model         | RAM   | Quality / Jakość      | Speed / Szybkość | Best for / Najlepsze do |
| ------------- | ----- | --------------------- | ---------------- | ----------------------- |
| `qwen3.5:2b`  | 2 GB  | Basic conversations   | Fast             | Testing, light chat     |
| `qwen2.5:7b`  | 5 GB  | Good quality          | Medium           | Daily use               |
| `qwen2.5:14b` | 10 GB | High quality          | Slower           | Detailed conversations  |
| `qwen2.5:32b` | 20 GB | Very high             | Slow             | Complex reasoning       |
| `llama3.1:8b` | 6 GB  | Good, English-focused | Medium           | English conversations   |
| `mistral:7b`  | 5 GB  | Good multilingual     | Medium           | European languages      |
| `gemma2:9b`   | 7 GB  | Good quality          | Medium           | General use             |

**Pull a model / Pobierz model:**

```bash
ollama pull qwen2.5:7b
```

**Change model without restart / Zmień model bez restartu:**
Edit `.env`, restart OpenClaw (`npm run dev`).

### Anthropic Claude (cloud, paid, highest quality)

```bash
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### MiniMax (cloud, alternative)

```bash
LLM_PROVIDER=minimax
MINIMAX_API_KEY=your-key
MINIMAX_MODEL=MiniMax-M2.5
```

### GLM / Z.ai (cloud, alternative)

```bash
LLM_PROVIDER=glm
GLM_API_KEY=your-key
GLM_MODEL=glm-4-flash
```

### Identity vs Model / Tożsamość a model

**EN:** The system prompt (identity) is independent from the model. You can run the same "Maja" personality on qwen:2b for testing and qwen:32b for production. The identity stays consistent — only the quality of responses changes.

**PL:** Prompt systemowy (tożsamość) jest niezależny od modelu. Możesz uruchomić tę samą osobowość "Maja" na qwen:2b do testów i qwen:32b w produkcji. Tożsamość pozostaje spójna — zmienia się tylko jakość odpowiedzi.

---

## 4. Connecting Channels

### Telegram (recommended / zalecane)

1. Open Telegram, search for `@BotFather` / Otwórz Telegram, wyszukaj `@BotFather`
2. Send `/newbot` → follow instructions → copy the token / Wyślij `/newbot` → postępuj zgodnie z instrukcjami → skopiuj token
3. Set in `.env`:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   ```
4. Start OpenClaw: `npm run dev`
5. Open your bot in Telegram and say hello / Otwórz bota w Telegramie i się przywitaj

**Available commands / Dostępne komendy:**

- `/start` — Introduction / Powitanie
- `/help` — Command list / Lista komend
- `/status` — System status (model, memory, gateway)
- `/recall` — What Soul remembers / Co Soul pamięta

### Discord

1. Go to https://discord.com/developers/applications
2. Create New Application → Bot → Copy token
3. Enable **MESSAGE CONTENT** intent in Bot settings
4. Generate invite URL (Bot scope + Send Messages permission)
5. Set in `.env`:
   ```bash
   DISCORD_BOT_TOKEN=your-token
   ```

**Note / Uwaga:** Discord adapter responds to mentions (`@YourBot`) and DMs. No slash commands yet.

---

## 5. Memory & Recall

### How Memory Works / Jak działa pamięć

Every conversation exchange is stored in Memphis as a blockchain entry:

Każda wymiana w rozmowie jest zapisywana w Memphis jako wpis blockchain:

```
[telegram:123456] User: kim jestem?
Assistant: Jesteś Marcin, twórca ekosystemu Memphis...
```

When you send a new message, OpenClaw searches Memphis for relevant past conversations and injects them into the system prompt as context.

Gdy wysyłasz nową wiadomość, OpenClaw przeszukuje Memphis w poszukiwaniu istotnych przeszłych rozmów i wstrzykuje je do promptu systemowego jako kontekst.

### What Gets Remembered / Co jest zapamiętywane

- Every message you send and every response you receive / Każda wiadomość i odpowiedź
- Tagged with your user ID (e.g., `telegram:123456`) / Otagowane Twoim ID
- Stored permanently in Memphis blockchain / Przechowywane trwale w blockchain Memphis
- Searchable by semantic similarity / Wyszukiwalne po podobieństwie semantycznym

### What Doesn't Get Remembered / Co nie jest zapamiętywane

- Commands (`/start`, `/help`, `/status`) / Komendy
- System errors / Błędy systemowe
- Conversations when Memphis is down (fail-open design) / Rozmowy gdy Memphis nie działa

### Testing Memory / Testowanie pamięci

```bash
# Tell your bot something specific
# Powiedz botowi coś konkretnego:
"My favorite color is blue and I have a cat named Luna"

# Later, ask:
# Później zapytaj:
"What's my cat's name?"

# Use /recall to see raw memories:
# Użyj /recall żeby zobaczyć surowe wspomnienia:
/recall
```

### Memory Without Memphis / Pamięć bez Memphis

If Memphis is not running, OpenClaw still works — conversations are just stateless (no recall between sessions). This is by design (fail-open).

Jeśli Memphis nie działa, OpenClaw nadal działa — rozmowy są po prostu bezstanowe (brak przywoływania między sesjami). To jest celowe (fail-open).

---

## 6. Customization Points

### Files You Can Modify / Pliki które możesz modyfikować

| File / Plik                      | What / Co                      | How / Jak                             |
| -------------------------------- | ------------------------------ | ------------------------------------- |
| `.env`                           | Model, channels, Memphis URL   | Edit values, restart                  |
| `src/gateway/loop.ts:13`         | Default system prompt          | Edit string, rebuild                  |
| `src/channels/telegram.ts:20`    | Bot display name               | Change `'Soul'` to your name          |
| `src/channels/telegram.ts:78-88` | `/status` and `/recall` output | Customize status format               |
| `src/memory/client.ts`           | Memory behavior                | How conversations are stored/recalled |
| `src/llm/ollama.ts`              | Ollama timeout, parameters     | Adjust timeout, temperature           |

### Environment Variables / Zmienne środowiskowe

```bash
# Identity / Tożsamość
OPENCLAW_SYSTEM_PROMPT="..."     # Override system prompt without code changes

# LLM Provider / Dostawca LLM
LLM_PROVIDER=ollama              # ollama | anthropic | minimax | glm
OLLAMA_MODEL=qwen3.5:2b          # Any Ollama model
OLLAMA_THINK=false               # Enable step-by-step reasoning (slower)

# Channels / Kanały
TELEGRAM_BOT_TOKEN=              # From @BotFather
DISCORD_BOT_TOKEN=               # From Discord Developer Portal

# Memory / Pamięć
MEMPHIS_API_URL=http://localhost:3000
MEMPHIS_API_TOKEN=               # Must match Memphis .env

# Logging
LOG_LEVEL=info                   # debug | info | warn | error
```

---

## 7. Real Experience: First Conversations

### What We Learned / Co się nauczyliśmy

When we first tested Soul on Telegram with `qwen3.5:2b`, here's what happened:

Gdy pierwszy raz testowaliśmy Soul na Telegramie z `qwen3.5:2b`, oto co się stało:

**Small models (2b) behave unpredictably / Małe modele (2b) zachowują się nieprzewidywalnie:**

- The model sometimes forgot its identity mid-conversation / Model czasem zapominał swoją tożsamość w trakcie rozmowy
- It occasionally invented facts about what Memphis and OpenClaw are / Czasem wymyślał fakty o tym czym jest Memphis i OpenClaw
- It switched languages randomly / Losowo przełączał języki

**What helped / Co pomogło:**

- A more detailed system prompt grounded the model better / Bardziej szczegółowy prompt systemowy lepiej uziemił model
- Switching to a 7b+ model dramatically improved consistency / Przejście na model 7b+ dramatycznie poprawiło spójność
- Memory recall gave the model real context to work with / Recall pamięci dał modelowi prawdziwy kontekst

**Commands that work well / Komendy które działają dobrze:**

- `/status` — quick system check / szybki check systemu
- `/recall` — see what's in memory / zobacz co jest w pamięci
- Regular conversation — the core experience / zwykła rozmowa — główne doświadczenie

**Tips / Wskazówki:**

- Start with a rich system prompt if using small models / Zacznij od bogatego promptu systemowego przy małych modelach
- Bigger models need less hand-holding in the prompt / Większe modele potrzebują mniej prowadzenia w promptie
- Test with `/recall` to verify memory is actually storing / Testuj `/recall` żeby zweryfikować czy pamięć faktycznie zapisuje
- If you see "Sorry, something went wrong" — check if Ollama is running / Jeśli widzisz ten komunikat — sprawdź czy Ollama działa

---

## 8. Going Further

### Ideas for Development / Pomysły na rozwój

**Tool calling / Wywoływanie narzędzi:**
Currently Soul responds only with text. Future versions could add tools:

- Read local files / Czytanie lokalnych plików
- Execute safe commands / Wykonywanie bezpiecznych komend
- Check weather, calendar / Sprawdzanie pogody, kalendarza
- Control smart home / Sterowanie inteligentnym domem

**Multiple personalities / Wiele osobowości:**
Run multiple OpenClaw instances with different `.env` files, each with its own Telegram bot and personality.

Uruchom wiele instancji OpenClaw z różnymi plikami `.env`, każda z własnym botem Telegram i osobowością.

**Voice / Głos:**
Integrate with Whisper (speech-to-text) and a TTS engine for voice conversations.

**Custom memory strategies / Własne strategie pamięci:**
Modify `src/memory/client.ts` to change how memories are stored and recalled — tag by topic, summarize before storing, prioritize recent memories.

### Contributing / Wkład

The Memphis ecosystem is open source. If you build something cool:

- OpenClaw gateway: https://github.com/Memphis-Chains/MemphisOS-OpenClaw
- Memphis core: https://github.com/Memphis-Chains/memphis
- MemphisOS control plane: https://github.com/Memphis-Chains/MemphisOS

---

**Your AI, your rules. / Twoje AI, Twoje zasady.**

**△⬡◈ Memphis Ecosystem — Build What's Yours**

**△⬡◈ Ekosystem Memphis — Zbuduj Co Twoje**
