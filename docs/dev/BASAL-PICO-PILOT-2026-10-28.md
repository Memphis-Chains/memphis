# Basal Pico: measured isolated pilot, 2026-10-28

Decision: keep Pico available for supervised experiments. This screen does not
justify automatic memory routing or a production model switch. The production
Basal service remains `basal-1.5-mini` on localhost:8000. The pilot used a separate
venv, model directory and localhost:8002; no operator memories were supplied.

## Measured result

The 50 Polish synthetic cases were frozen before inference. All responses had
finite, normalized distributions and consistent typed readouts. Accuracy below
means top-option agreement with the frozen expected label; `score` is also
checked against the distribution's expected ordinal value.

| Group                       | Correct | Accuracy | Wall latency p50 | Wall latency p95 |
| --------------------------- | ------: | -------: | ---------------: | ---------------: |
| Memory/action routing       |   16/20 |      80% |           8.75 s |          11.16 s |
| Explicit evidence, yes/no   |   19/20 |      95% |           3.77 s |           4.08 s |
| Completeness, ordinal score |    7/10 |      70% |           4.75 s |           6.40 s |
| All cases                   |   42/50 |      84% |           4.79 s |          10.27 s |

p95 uses the nearest rank, separately within each group. One warmup request
took 3.19 s and is excluded from these 50 timings. Peak process RSS was
1,634.07 MiB (about 1.60 GiB); the host retained at least 6,352.82 MiB available
during sampling. The pilot ran on two CPU threads. These are observations on
this host, not producer hardware results or an unloaded throughput benchmark.

The eight wrong cases were `route-03`, `route-04`, `route-13`, `route-20`,
`evidence-05`, and `sufficiency-05` through `sufficiency-07`. In particular:

- Two requests to recall earlier facts were sent to ordinary reply/clarification.
- An underspecified reminder was sent to journal instead of clarification.
- A greeting containing a quoted instruction was unnecessarily sent to clarification.
- An explicit Polish-language preference was missed.
- All three partially complete date/amount records were scored as empty, with
  confidence 0.930, 0.970 and 0.931. High confidence did not make these correct.

The quoted-instruction case did not cause a write or a tool execution. Every
classification remained an observation, and no execution permission was inferred
from its label or confidence.

## Threshold coverage and uncertainty

Apply the producer's **per-type** thresholds from `CALIBRATION.gguf.json`, not
its informational pooled threshold:

| Producer target label | Eligible in this screen | Errors among eligible |
| --------------------- | ----------------------: | --------------------: |
| `0.01`                |             10/50 (20%) |                  0/10 |
| `0.05`                |             25/50 (50%) |                  1/25 |

These are advisory eligibility counts on a small hand-authored screen. They do
not establish a Memphis-domain 1% or 5% error rate. The `0.01` file entry has no
Boolean or score threshold; neither target has a score threshold. Such cases
are ineligible regardless of their confidence. The 5% policy's wrong eligible
case was `route-03` (confidence 0.891).

The producer explicitly describes domain-transfer failures and the need to fit
thresholds on one's own labeled data in the
[Pico GGUF model card](https://huggingface.co/Remek/basal-omni-pico-GGUF).
The replay tool reports eligibility; it never executes a proposed action.

## Exact candidate and host

- Model: `Remek/basal-omni-pico-GGUF`, revision
  `a9380832ca979d833bd68c2f369b3c13ee8c47a3`.
- Weights: `basal-omni-pico-Q8_0.gguf`, 811,843,104 bytes, SHA-256
  `f8ef7349c730fca055c01255cdaa5c7b94848285d634b61996bbde5835437354`.
- All producer `SHA256SUMS` entries verified, including tokenizer, template,
  `basal.json` and both calibration files.
- GGUF calibration SHA-256:
  `b7c9ad8f3270ae9411eeba9f5f4f18594be843aa812f9c061efb2a6cdec81cd1`.
- Engine: Basal 2.4.1, release commit
  `b20f0f9b159f71726459aa98ede1356ab65695fd`, installed into its own venv.
- Python 3.12.13, llama-cpp-python 0.3.36, torch 2.14.1+cpu,
  transformers 5.17.0, numpy 2.5.4.
- Backend: CPU GGUF, `qwen35` recurrent model, prompt format 2, one option
  order, canonical layout. The official engine performs sequential recurrent
  decode. No local prompt/scoring substitute was used.
- CPU: Intel i3-2120, 2 cores/4 threads, AVX without AVX2/FMA/F16C.
  llama.cpp reports SSE3, SSSE3 and AVX; GPU offload is unavailable in this build.
  Host RAM: 15,423 MiB. GTX 960 acceleration was not measured.

The engine's [GGUF documentation](https://github.com/rkinas/basal/blob/v2.4.1/docs/GGUF.md)
explains why the tokenizer/calibration accompany the weights and why hybrid
models need sequential CPU decode.

## Reproduce

The checked-in cases are
[`basal-pico-screen.pl.jsonl`](../../tests/fixtures/basal-pico-screen.pl.jsonl),
SHA-256 `179696d592e5e6a6f78bd079bf2f3ec9187e4ee927d67d26fe20b1b824ae1af1`.
Do not tune this frozen screen after observing its answers and then report it
as an independent evaluation. A future acceptance set must be separately labeled.

Provision the pinned candidate in an isolated directory/venv using the
producer's recipe. A CPU build for this host must avoid AVX2, FMA and F16C;
a wheel built for a newer CPU is not interchangeable. Keep the production
service and model configuration unchanged. Launch the official server with:

```bash
OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 HF_HUB_OFFLINE=1 \
  "$PILOT_VENV/bin/basal-serve" \
  --model "$PILOT_MODEL" --name basal-omni-pico-Q8_0-pilot \
  --mode gguf --gguf "$PILOT_MODEL/basal-omni-pico-Q8_0.gguf" \
  --orders 1 --max-batch 1 --context-overflow refuse \
  --host 127.0.0.1 --port 8002
```

`PILOT_VENV` and `PILOT_MODEL` refer to the isolated venv and verified model
directory. Use the normal operator authorization process before classification.
Then run the standard-library replay tool from the repository root, choosing a
new output directory whose parent already exists:

```bash
python3 scripts/basal/pilot_screen.py \
  --endpoint http://127.0.0.1:8002 \
  --calibration "$PILOT_MODEL/CALIBRATION.gguf.json" \
  --output /path/to/new-pico-screen-run
```

It refuses an existing output directory, non-local endpoints, incompatible
server metadata, malformed distributions and inconsistent typed readouts.
It saves the exact case/calibration hashes, model metadata, responses and
per-type eligibility counts. `--limit` is only a smoke subset and its actual
count appears in the report. Request timeout defaults to 120 seconds.
The CLI tool does not sample RAM: the original host run sampled `/proc`
every 500 ms and recorded the process high-water mark separately.

The replay implementation reproduced the aggregate of all 50 archived
responses exactly. A separate live smoke covered choice, Boolean and score
responses (3/3), without including those repetitions in the 50-case result.

Host evidence, installation metadata, native-library hashes, resource samples
and full raw results live under
`/home/memphis/runtime-archives/basal-pico-pilot-2026-10-28/`.
The model/engine are under `/home/memphis/model-pilots/basal-pico-2026-10-28/`;
the isolated venv is `/home/memphis/.venvs/basal-pico-pilot-2026-10-28/`.

## Memphis adapter control

Three fixed cases were run through the deployed Memphis CLI against each
service after the isolated screen, without concurrent model requests:

| Case             | Pico inference |  Existing 1.5-mini inference | CLI result                                       |
| ---------------- | -------------: | ---------------------------: | ------------------------------------------------ |
| `route-01`       |         9.39 s |                      38.16 s | Both valid and correct                           |
| `evidence-02`    |         3.68 s | Not reported after rejection | Pico valid and correct; legacy response rejected |
| `sufficiency-08` |         4.88 s |                      20.95 s | Both valid and correct                           |

This tiny control establishes compatibility, not comparative accuracy. The
legacy Boolean readout was rejected by the deployed probability validator;
it was not accepted as a confident answer. Its CLI call took 20.95 s wall time.
Full CLI wall times include process startup and discovery, so the table uses
the accepted responses' reported inference time.

The raw screen uses `option_keys: hide`; the existing Memphis CLI shows option
keys. Its comma-separated argument syntax also requires replacing commas in
the Boolean and score descriptions with semicolons. These disclosed prompt
variants are not additional observations in the 50-case screen.

The official Pico engine's `/health` reports queue status, without the
legacy wrapper's model/threshold fields. The deployed Memphis CLI therefore
used its 0.93 fallback and reported `calibration: unreported`. It returned
`auto=true` for the routing and Boolean control and `auto=false` for the score
control. These are caller-policy suggestions, not this screen's per-type
producer-threshold policy. In particular, the Boolean case has no `0.01`
per-type threshold despite the CLI's advisory flag. Neither flag is authority
to mutate memory. The existing 1.5-mini service continues to report its own
threshold, 0.9546241492914076.

Before any production adoption, evaluate a separately labeled Memphis-domain
set, define per-type deferral explicitly, and verify the caller's exact prompt
and policy. For the companion goal, persistent-memory tests across restart,
correction and model changes remain the next independent task.
