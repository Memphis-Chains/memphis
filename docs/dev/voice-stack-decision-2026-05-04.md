# Voice stack decision — 2026-05-04

**Status:** decision locked, implementation queued (Sprint H).
**Trigger:** upcoming live demo where Memphis must speak Polish through Memphis Agent end-to-end without cloud STT/TTS dependency.
**Hardware budget:** ≤ 4 GB VRAM (operator's GTX 960 Maxwell box, same envelope as Kartograf).

## Constraint summary

| Constraint | Value | Source |
|---|---|---|
| VRAM cap | 4 GB total | Kartograf spec (`docs/dev/KARTOGRAF-SPEC.md`); operator's GTX 960 |
| Latency goal | <500 ms for STT, <100 ms for TTS | live demo conversational |
| Language | Polish primary; multilingual nice-to-have | demo audience PL |
| Network | offline-capable (no HF/Google API hard dep) | demo venue not guaranteed |
| Existing surface | `src/gateway/voice/voice-service.ts` (210 LOC, HF Whisper + MMS-TTS-Pol cloud) + `local-whisper-adapter.ts` (98 LOC, scaffolded but unwired) | repo audit 2026-05-04 |

## Decision

| Layer | Engine | Model | Footprint | Why |
|---|---|---|---|---|
| **STT** | **faster-whisper** (CTranslate2) | `medium` INT8 quantized | ~1.2 GB VRAM, ~770 M params | 6× faster than vanilla Whisper, 99% large-v3 accuracy, Polish well-supported, battle-tested, INT8 quantization lets us coexist with Kartograf inference on 4 GB GPU |
| **TTS** | **Piper** | `pl_PL-gosia-medium.onnx` | ~80 MB CPU only, no GPU | <100 ms latency = real-time conversational, no GPU contention with STT/Kartograf, ONNX-backed (consistent with Kartograf runtime), Polish voice already maintained upstream |

**Stack feasibility envelope:**
- STT: 1.2 GB VRAM
- TTS: 0 GB VRAM (CPU)
- Kartograf inference (when wired): ~1 GB VRAM
- Total VRAM: ~2.2 GB → headroom of ~1.8 GB inside the 4 GB cap
- TTS on CPU keeps the GPU free for parallel STT + Kartograf pointer/router

## Why these engines (vs. alternatives)

### STT alternatives considered

| Option | Decision | Reason |
|---|---|---|
| HuggingFace Whisper Inference API (current default) | KEEP as fallback | Cloud-only, breaks the "offline demo" requirement; works when network available |
| `whisper.cpp` server (operator-spawned) | DOWNGRADE to backup option | Needs operator to manually `make` and start binary; scaffold exists in `local-whisper-adapter.ts` but ergonomically rough |
| **`faster-whisper` (Python, CTranslate2)** | **CHOSEN** | INT8 quantization halves VRAM vs vanilla; CT2 is C++ under the hood (fast); `large-v3-turbo` upgrade path stays open if accuracy needs it |
| `nodejs-whisper` (npm wrapper around whisper.cpp) | REJECT | Smaller community; no Polish-specific tuning visible; tightly coupled to whisper.cpp build |
| Voxtral / other 2026 contenders | REJECT for this demo | Newer, less battle-tested for Polish; demo wants known-good |

### TTS alternatives considered

| Option | Decision | Reason |
|---|---|---|
| HuggingFace `facebook/mms-tts-pol` (current default) | KEEP as fallback | Cloud-only; works when network available |
| Google Cloud TTS `pl-PL-Standard-B` (current opt-in) | KEEP as paid premium | Per-character cost; only triggered if quota allows |
| **Piper `pl_PL-gosia-medium.onnx`** | **CHOSEN for offline default** | Lowest footprint, fastest, ONNX-backed, used in production on Raspberry Pi and home automation |
| Coqui XTTS-v2 | REJECT for this demo | Higher quality + voice clone but ~1.8 GB VRAM, contends with Kartograf+STT inside 4 GB cap |
| Bark (Suno) | REJECT | ~5 GB VRAM, off-budget |

## Implementation plan (Sprint H — queued)

The demo path needs **two TS adapters wired into the existing surface**, not a rewrite. `voice-service.ts` already has `speechToText()` / `textToSpeech()` cloud paths and `local-whisper-adapter.ts` already declares the `whisper-server` HTTP contract on `localhost:9000`. New work is wiring symmetric local TTS + a chooser.

### Sprint H scope (3 PRs, ~1.5–2 days)

1. **PR-A: faster-whisper service runbook + STT chooser**
   - `docs/operator/voice-local-stt.md` — runbook to install `pip install faster-whisper`, run `python -m faster_whisper.server --model medium --device cuda --compute_type int8` on `localhost:9000`
   - `voice-service.ts:speechToText()` — when `MEMPHIS_VOICE_STT_LOCAL=true` (or HF token absent), route through `local-whisper-adapter.ts` instead of HF
   - Health check on boot: warn loud if local mode requested but server unreachable
   - Tests: add `tests/integration/voice-local-stt.test.ts` mocking the HTTP server

2. **PR-B: Piper local TTS adapter**
   - `src/gateway/voice/local-piper-adapter.ts` — mirror shape of `local-whisper-adapter.ts`, calls `localhost:5500/tts` (Piper HTTP server convention)
   - `docs/operator/voice-local-tts.md` — runbook to install Piper binary + download `pl_PL-gosia-medium.onnx` model files, run as systemd service
   - `voice-service.ts:textToSpeech()` — when `MEMPHIS_VOICE_TTS_LOCAL=true` (or HF token absent), route through Piper
   - Tests: same shape as STT

3. **PR-C: Voice mode operator switch + doctor visibility**
   - `MEMPHIS_VOICE_MODE=cloud|local|auto` env (default `auto` — local if HF token absent, cloud if present)
   - Doctor check `ta12-voice-stack` reports STT engine + TTS engine + reachability of each
   - `memphis voice status` CLI command surfaces the same JSON
   - `~/.memphis/config/voice.json` cache so the chooser is sticky between turns

### Operator commands (post-Sprint H)

```bash
# One-time setup (Linux, GTX 960 Maxwell)
pip install faster-whisper
python -m faster_whisper.server --model medium --device cuda --compute_type int8 --port 9000 &

# Piper
curl -L https://github.com/rhasspy/piper/releases/latest/download/piper_linux_x86_64.tar.gz | tar xz
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx
wget https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/gosia/medium/pl_PL-gosia-medium.onnx.json
./piper --model pl_PL-gosia-medium.onnx --port 5500 &

# Memphis runtime
export MEMPHIS_VOICE_MODE=local
memphis tui                  # voice off by default; /voice on per chat to enable
memphis voice status         # confirms both engines healthy
memphis doctor | grep voice  # ta12-voice-stack: pass — STT(faster-whisper@:9000), TTS(piper@:5500)
```

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Piper Polish voice (gosia) sounds robotic compared to MMS-TTS-Pol | medium | XTTS-v2 escape hatch documented; operator can flip `MEMPHIS_VOICE_TTS_QUALITY=high` to pull Coqui later |
| faster-whisper INT8 medium drops Polish word accuracy below 90% | low | Reproducible test: WER on a 60s Polish audio clip during Sprint H smoke; fallback to large-v3-turbo (~1.5 GB VRAM, still in budget) |
| Live demo on a different machine without GTX 960 | medium | CPU mode is supported by both engines; document `--device cpu` fallback runbook (latency ~3–5× slower but functional) |
| ffmpeg missing on demo box | low | `voice-setup.md` lists it as prereq; install line included in operator runbook |
| Telegram voice handler regressions | low | Existing path stays cloud-by-default; local mode is opt-in via env |

## Decision recording

- Date: 2026-05-04
- Triggered by: live demo prep
- Owners: Wodzu (operator), Memphisek (Claude Code agent)
- Supersedes: nothing — extends existing `voice-service.ts` surface
- Reverses if: WER on Polish 60s test clip < 90% with faster-whisper medium INT8 (drops to large-v3-turbo); or Piper voice quality blocks demo (drops to XTTS-v2 with reduced Kartograf inference budget)

## References

- `src/gateway/voice/voice-service.ts:60-210` — existing dual-provider STT/TTS surface
- `src/gateway/voice/local-whisper-adapter.ts:1-98` — pre-existing whisper.cpp scaffold
- `src/gateway/channels/telegram.ts:743-923` — Telegram voice handler (STT inbound + TTS outbound)
- `docs/operator/voice.md`, `voice-setup.md` — current cloud runbook
- `docs/dev/KARTOGRAF-SPEC.md:4` — 4 GB VRAM cap that drove the engine selection
- [Northflank — Best open source STT 2026](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks)
- [Local AI Master — Coqui TTS review 2026](https://localaimaster.com/models/coqui-tts)
- [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [rhasspy/piper](https://github.com/rhasspy/piper)
