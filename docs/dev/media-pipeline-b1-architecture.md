# Memphis Media Pipeline — Specyfikacja B1

> **Status:** B1 — koncepcja architektoniczna  
> **Data:** 2026-05-05  
> **Autor:** Memphis Agent (Wodzu)  
> **Wersja Memphis:** v1.8.0

---

## 🎯 Cel

Memphis Agent ma własny kanał percepcji — lokalny LLM przetwarza multimedia (zdjęcia, video, audio) i zapisuje semantyczne rozumienie do łańcuchów. Bez chmury, bez zewnętrznych API, bezpieczne.

---

## 📐 Architektura

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memphis Media Pipeline                        │
│                                                                 │
│  ┌──────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  INPUT   │───▶│  LOCAL LLM STACK │───▶│  CHAIN OUTPUT   │  │
│  └──────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                 │
│  📸 Image      → llava / moondream2   → journal (semantic)      │
│  🎥 Video      → ffmpeg + VLM        → cases (entities)        │
│  🎤 Audio      → whisper.cpp         → insights (nudges)       │
│                                                                 │
│  Provider: Ollama (local, no cloud)                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Stack technologiczny

### Audio
- **whisper.cpp** — lokalna transkrypcja audio→text
- Modele: tiny/base/small (77MB/140MB/488MB)
- Wejście: OGG, MP3, WAV, WebM
- Wyjście: plain text → Memphis journal

### Obrazy
- **llava** — multimodal (image → description)
- **moondream2** — szybki vision model (fast inference)
- Wejście: PNG, JPG, WebP
- Wyjście: semantic description → journal + cases

### Video
- **ffmpeg** — ekstrakcja keyframes (1 frame / 5s)
- **local VLM** — analiza każdego frame'a
- Wejście: MP4, MOV, AVI
- Wyjście: timeline summary → cases (entities, scenes)

---

## 🗂️ Ścieżki plików

```
~/memphis/
├── config/
│   └── media.yaml              # Konfiguracja pipeline
├── media/
│   ├── incoming/               # Input media (zdjęcia, video, audio)
│   ├── archive/               # Przetworzone (archiwum)
│   └── cache/                 # Tymczasowe (keyframes, transkrypcje)
└── media-orchestrator/
    └── src/
        ├── audio.ts            # whisper.cpp wrapper
        ├── vision.ts           # llava/moondream wrapper
        ├── video.ts            # ffmpeg + VLM pipeline
        ├── orchestrator.ts     # Główny orchestrator
        └── chain-output.ts     # Output → journal/cases/insights
```

---

## 📥 Tool: `memphis media ingest`

```bash
# Składnia
memphis media ingest <path> [--type audio|image|video|auto] [--watch]

# Przykłady
memphis media ingest ~/zdjecia/raport.jpg
memphis media ingest ~/nagrania/wypowiedz.ogg --type audio
memphis media ingest ~/film/prezentacja.mp4 --watch
```

### Input types
- `audio` — whisper transcription
- `image` — vision analysis
- `video` — frame extraction + full analysis
- `auto` — auto-detect based on extension

---

## 📤 Chain Output

### journal (semantic memory)
```json
{
  "content": "Na zdjęciu: budynek w stylu Beskid Żywiecki, drewniany, czyny dach. Osoba trzyma dokument.",
  "tags": ["image", "building", "beskid", "document"],
  "chain": "journal"
}
```

### cases (knowledge graph)
```json
{
  "actor": "user",
  "target": "building",
  "instrument": "image_analysis",
  "location": "beskid-zywiecki",
  "case": "architektura-tradycyjna"
}
```

### insights (proactive nudges)
```
"Na zdjęciu widać budynek który może wymagać konserwacji — zauważono pęknięcia w okolicy dachu. Czy dodać to do listy zadań?"
```

---

## ⚙️ Konfiguracja `media.yaml`

```yaml
# ~/memphis/config/media.yaml

media_pipeline:
  enabled: true
  
local_llm:
  provider: ollama
  endpoint: http://localhost:11434
  
  models:
    audio: whisper        # whisper.cpp
    image_fast: moondream2   # quick vision
    image_full: llava     # detailed vision
    video: llava          # video frame analysis
  
storage:
  input_dir: ~/memphis/media/incoming
  archive_dir: ~/memphis/media/archive
  cache_dir: ~/memphis/media/cache
  
processing:
  video_frame_interval: 5   # seconds between keyframes
  max_video_frames: 20      # limit per video
  audio_language: pl        # Polish transcription
  
chain_output:
  journal: true
  cases: true
  insights: true
```

---

## 🔒 Bezpieczeństwo

```
✅ Wszystko lokalne — żadnych zewnętrznych API
✅ Vault trzyma ewentualne credentials (gdyby Ollama wymagał auth)
✅ Input directory sandboxed do ~/memphis/media/
✅ Chain output via standard memphis tools (audit trail)
✅ No data leaves the machine
```

---

## 📊 Status implementacji

```
B1 ✅  Koncepcja architektoniczna (TAK)
B2 ⬜  Specyfikacja techniczna (do zrobienia)
B3 ⬜  Prototype implementation (do zrobienia)
```

---

## 📝 Zależności od Memphis core

```
✅ Chain-backed storage (journal, cases) — istnieje
✅ Ollama provider integration — istnieje
✅ Vault secrets — istnieje
✅ Agent workflow (Mode D) — istnieje
❌ whisper.cpp binding — TRZEBA DOKLEIĆ
❌ llava/moondream config — TRZEBA DOKLEIĆ
❌ Video frame sampler — TRZEBA DOKLEIĆ
❌ Media ingestion tool — TRZEBA DOKLEIĆ
```

---

## 🚀 Następne kroki

1. **B2** — Szczegółowa specyfikacja modułów (audio.ts, vision.ts, video.ts, orchestrator.ts)
2. **B3** — Prototype: whisper.cpp binding + test na próbce audio
3. **B4** — Integracja z Memphis runtime (tool registry, cron watch)
4. **B5** — UI: `memphis media status` + `memphis media watch`

---

*Ta specyfikacja jest własnością Memphis runtime i podlega tej samej licencji co projekt Memphis.*