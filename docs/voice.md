# Voice (STT/TTS) — Telegram

Sprint 9 closes out the voice path that was scaffolded earlier. STT
and TTS in `src/gateway/voice/voice-service.ts` were already wired
into `bot.on('message:voice', ...)` — Sprint 9 adds the missing
operator controls: a per-chat enable/disable toggle and a daily TTS
quota so a chatty chat can't run up the bill.

## What works end-to-end

1. **Inbound voice** — Telegram OGG/OPUS message arrives →
   `bot.on('message:voice')` downloads via `getFile` →
   `speechToText()` calls HuggingFace Whisper (default
   `openai/whisper-large-v3`) → transcript prefixed with
   `[Transkrypcja]` is echoed to the chat → the same text feeds the
   normal turn pipeline as if the operator had typed it.
2. **Outbound TTS** — when the inbound message was voice, the next
   `send()` from the agent automatically synthesizes the reply via
   `textToSpeech()` (HuggingFace `facebook/mms-tts-pol` by default,
   or Google Cloud TTS when `MEMPHIS_TTS_PROVIDER=google`) and ships
   it as a Telegram voice message **in addition** to the text reply.
   Text always goes first; TTS is best-effort.

## Sprint 9 additions

### `/voice on|off|status`

```
/voice              # show current preference + today's TTS usage
/voice status       # alias of /voice
/voice on           # enable TTS replies (default)
/voice off          # text only — voice → text input still works
```

State is per-chat and in-process; restart resets to `on`. Operators
who want a durable default should set their own `.env` defaults; the
toggle is for short-term overrides.

### Daily TTS quota

Every TTS call increments a per-chat day counter. `MEMPHIS_TTS_DAILY_CHAT_LIMIT`
caps utterances/chat/day (default 100; `0` disables TTS entirely as a
kill switch).

When a chat hits its limit Memphis sends a single text notice:

```
(voice reply skipped — daily TTS limit 100/100 reached; resets at UTC midnight)
```

This is intentional — silently dropping voice replies is the wrong
default; the operator deserves to know why.

When the chat preference is `off` or the env kill switch is `0`, the
voice reply is silently skipped (no notice). The operator opted in to
no-voice and shouldn't get a notification on every turn.

Counters reset at UTC midnight. The day key is computed inside
`voice-policy.ts` via the same `now` clock that the policy reads, so
tests can fast-forward without mocking globals.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `HUGGINGFACE_API_TOKEN` | (required) | HF Inference token; without it, voice is disabled entirely |
| `MEMPHIS_STT_MODEL` | `openai/whisper-large-v3` | STT model on HF Inference |
| `MEMPHIS_TTS_PROVIDER` | `huggingface` | `huggingface` or `google` |
| `MEMPHIS_TTS_MODEL` | `facebook/mms-tts-pol` (HF) or `pl-PL-Standard-B` (Google) | TTS model/voice |
| `GOOGLE_TTS_API_KEY` | — | required when `MEMPHIS_TTS_PROVIDER=google` |
| `MEMPHIS_TTS_DAILY_CHAT_LIMIT` | `100` | per-chat per-day TTS quota; `0` disables TTS |

`MEMPHIS_TTS_DAILY_CHAT_LIMIT` is **hot** — change it and call
`/config reload` from any surface; the next TTS call sees the new
ceiling.

## Failure modes

| Symptom | Cause | What happens |
|---|---|---|
| STT returns empty text | HF rate limit, slow audio | Operator gets `STT error: ...` reply; turn is **not** dispatched |
| TTS returns 503 | HF model warming | Text reply still ships; voice reply silently skipped (best-effort) |
| Daily limit reached | Quota | One-line text notice; subsequent voice messages still get text replies |
| `/voice off` set | Operator preference | Voice → text input keeps working; replies are text only |
| `MEMPHIS_TTS_DAILY_CHAT_LIMIT=0` | Kill switch | No TTS attempts; no notice; voice → text input still works |

## Tests

`tests/unit/voice-policy.test.ts` — preference default + isolation,
quota allow/block paths, env kill switch, invalid env fallback,
midnight rollover behavior, preference persistence across rollover.

The voice-service network paths (HF / Google fetch) stay deferred to
the existing service-level tests — Sprint 9 focuses on the policy
layer, which is what the operator actually controls.
