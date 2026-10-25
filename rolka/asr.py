import sys, json, wave
import numpy as np
from faster_whisper import WhisperModel


def load_wav16k(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, w.getsampwidth()
        assert w.getframerate() == 16000, w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


model_name = sys.argv[1] if len(sys.argv) > 1 else "small"
audio = load_wav16k("take.wav")
print(f"### audio samples={len(audio)} = {len(audio)/16000:.1f}s", flush=True)

model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=2)
segments, info = model.transcribe(
    audio, language="pl", task="transcribe", beam_size=5,
    vad_filter=True, vad_parameters=dict(min_silence_duration_ms=400),
    word_timestamps=True, condition_on_previous_text=False,
)
print(f"### model={model_name} lang={info.language} p={info.language_probability:.3f}", flush=True)
rows = []
for s in segments:
    rows.append(dict(start=round(s.start,2), end=round(s.end,2), text=s.text.strip(),
                     words=[dict(w=round(x.start,2), e=round(x.end,2), p=round(x.probability,2), word=x.word) for x in (s.words or [])]))
    print(f"[{s.start:7.2f} -> {s.end:7.2f}] {s.text.strip()}", flush=True)
json.dump(rows, open("take.json","w"), ensure_ascii=False, indent=1)
print("### wrote take.json,", len(rows), "segments")
