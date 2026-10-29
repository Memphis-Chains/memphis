# Basal CPU service and the 2.5 configurator — 2026-10-29

The existing `basal-1.5-mini` GGUF service has two independent service bugs:
its Boolean label can contradict its probability distribution, and synchronous
inference inside its async HTTP handler blocks health requests. The change
corrects the winning Boolean label, moves serialized inference off the HTTP
event loop, and reuses identical requests in a bounded process-local cache.
It does not replace weights, prompts, calibration or the model execution backend.

## Host measurements

One synthetic Polish Boolean request was submitted to the installed service
and an isolated candidate on localhost:8003, using the same snapshot,
Q8_0 weights, three CPU threads, question and single option order.

| Observation | Installed service | Candidate |
| --- | --- | --- |
| Probability of `yes` | 0.9870125722841271 | 0.9870125722841271 |
| Returned Boolean label | `no` (contradicts distribution) | `yes` |
| First request wall time | 21.887 s | 20.197 s |
| Repeated identical request, median of 5 | Not cached | 0.00179 s |
| Health request during inference | Timed out at 3 s | 0.0116 s |

The first-request timings are individual observations, not evidence of faster
model computation. Only exact cache hits avoid inference. The probability
distribution was identical; this is a readout correction, not an accuracy
benchmark. Further live controls exercise the deployed Node validator with
choice, Boolean and score results. These small controls do not establish
domain accuracy or validate a threshold's claimed error rate.

## Cache and scheduling contract

The cache holds up to 32 results for 300 seconds by default. Set
`BASAL_CACHE_ENTRIES=0` or `BASAL_CACHE_TTL_SECONDS=0` to disable it.
It is cleared on process restart and writes no request or result files.
The key includes the engine identity and exact state, questions, language,
option ordering and number of option orders. Different or corrected input
cannot reuse the old answer. Responses are copied before being returned.

`usage.cache_hit` identifies reuse; a cache hit reports `inference_ms: 0`
and its own request latency instead of presenting the original inference
time as new work. The cache does not assert calibration or confer execution
permissions. Existing Node/Rust validators and advisory thresholds still apply.

The mutable model context executes one request at a time, with at most four
pending requests. Excess requests receive HTTP 503 and `Retry-After: 1`.
Health and already cached requests remain available during inference. Cancelling
an HTTP client does not release its queue slot before the underlying model
call finishes. Invalid types, orders and criteria are rejected before any
question in a request consumes model computation.

Standard-library Python regressions cover Boolean consistency, score readout,
cache identity/expiry/eviction/isolation, disabled caching, inference failure,
health responsiveness, duplicate coalescing, queue capacity and cancellation.
A Vitest wrapper runs them in the normal repository checks without loading
weights or requiring Python ML packages.

## What the 2.5 configurator makes available

The producer's [configurator](https://basal.si5.pl/start/) and its
[manifest](https://basal.si5.pl/assets/start/manifest.json?v=1) were retrieved
on 2026-10-29. The manifest contains 94 CLI options, 17 modes and 8 models;
the planner defines 11 hardware profiles. Its metadata explicitly says
`releaseStatus: preview`, `releaseDate: 2026-11-03`,
`publicReleaseChecked: false`, and targets `v2.5.0`. The public repository
did not yet expose that tag when checked. A preview is not an installed
or verified engine release.

The official planner generated CPU/GGUF Q8_0 preview artifacts for the existing
Pico experiment, bound to localhost:8002 with one concurrent request and a
2048-token context. They are retained for review, not executed or promoted.
The installed service remains the measured mini checkpoint. The prior
[Pico screen](BASAL-PICO-PILOT-2026-10-28.md) is still 42/50 and does not
justify automatic memory routing.

This host's i3-2120 has AVX without AVX2/FMA/F16C. Future native builds need
those unavailable instructions explicitly disabled, as in the verified pilot;
the configurator's generic CPU profile alone does not establish binary
compatibility. Its installer also verifies the release tag before installing.
The GTX 960 is not an Ampere/Ada GPU. A separate Vulkan experiment would need
its own supported build, numerical parity and latency measurements.

Source snapshots, generated preview files, before/after requests and responses,
and deployment receipts are kept privately under
`/home/memphis/runtime-archives/basal-configurator-2026-10-29/`.

Deploy only the tested Python service file, retaining its previous version
and using the canonical conscious operator grant and HALT check. After restart,
verify model identity, readiness, Boolean consistency, repeated-request reuse
and health availability. The Memphis Node service and native binaries do not
need to restart for this Python service change.
