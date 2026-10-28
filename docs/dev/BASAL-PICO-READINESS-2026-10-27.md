# Basal Pico and Memphis — 2026-10-27

The operator wants a dependable long-term companion: continuity of memory,
respect for private data and permissions, clear evidence, corrections and
honest uncertainty. Evaluate changes against those behaviours, rather than
model size or a benchmark number alone.

## Verified candidate and current installation

The smallest published Basal candidate is
[`Remek/basal-omni-pico`](https://huggingface.co/Remek/basal-omni-pico), a
0.8B text-decision model based on Qwen3.5-0.8B. Despite the Omni name, the
published Pico recipe is for text decisions. The larger Omni mini/max family
provides image/audio capabilities. See the [producer model table](https://github.com/rkinas/basal#models).

The pinned GGUF candidate is `Remek/basal-omni-pico-GGUF` at
`a9380832ca979d833bd68c2f369b3c13ee8c47a3`:

- `basal-omni-pico-Q8_0.gguf`: 811,843,104 bytes.
- SHA-256: `f8ef7349c730fca055c01255cdaa5c7b94848285d634b61996bbde5835437354`.
- Apache-2.0, as declared in the model metadata.
- Prompt format 2, with up to 255 readout codes. Model-specific tokenizer,
  chat template, `basal.json` and backend-specific calibration accompany it.
- The [GGUF model card](https://huggingface.co/Remek/basal-omni-pico-GGUF)
  requires Basal 2.3.2+ and llama-cpp-python 0.3.36+ for the recipe it validates.
  Its hybrid `qwen35` architecture needs the corrected sequential CPU decode.

Inspection of the existing localhost service found `basal-1.5-mini`, GGUF,
CPU, ready. Its Python engine package reports version 1.0.0 and the local
prompt module explicitly implements format 1 with ten option letters.
Neither that renderer nor the current ten-option Memphis adapter has been
upgraded to the Pico protocol by this change. Replacing only a GGUF file would
leave the prompt/readout and calibration incompatible.

The inspected host has an i3-2120 (AVX, no AVX2), 16 GiB RAM and GTX 960
4 GiB. A CPU GGUF pilot needs a compatible build and measured memory/latency;
newer GPU fast-mode requirements do not establish Maxwell compatibility.
Only public metadata/calibration/card files were fetched in this investigation.
Pico weights were not downloaded, and the running Basal service was not changed.
No claim about Pico latency on this CPU has been measured.

## Roles in Memphis

Basal can advise which memory zone or tool fits a request, whether retrieved
passages are sufficient, whether a correction contradicts a stored statement,
and whether uncertainty warrants a question. Classes are described in the
request; this can reduce the need to train a fixed taxonomy for every decision.

A conversational model still writes and reasons in dialogue. Retrieval needs
its own embedding/index provider; Basal typed decisions do not supply a verified
Kartograf 256-dimensional checkpoint. Memory provenance, consent, correction,
backup and restoration remain runtime responsibilities. A classifier's
confidence never grants tool permissions or substitutes for operator consent.
This work does not activate a model, change Kartograf labels or close Q2 gates.

## Decision boundary hardening

The Node MCP/gateway/CLI adapter now validates response type, option membership,
finite normalized probabilities, confidence and the selected answer's
consistency with the distribution. Boolean and expected-score responses are
checked against their protocol semantics. The inspected legacy Python wrapper can
return a Boolean label that disagrees with its own probability distribution;
the Node adapter rejects that response instead of presenting a confident answer.
Invalid caller thresholds are rejected
rather than clamped or silently replaced. Backend errors are summarized without
echoing their payload, successful response bodies are capped at 64 KiB, and the
request deadline covers body reads after headers arrive.

The CLI's outer `ok` follows the classifier result. Service deferral or explicitly
unvalidated calibration prevents `auto`. A legacy response without calibration
metadata is labeled `unreported`; its threshold flag is advisory eligibility,
not a certificate. The existing Tier 2 classification registration and all
execution permission gates remain in force.

The legacy 0.93 default remains a caller policy for compatibility. It does not
promise a 1% error rate. Refit and evaluate thresholds for the selected
model/backend and Memphis domain, using a held-out labeled set. The producer
explicitly reports limits on transfer of Pico calibration outside its own data;
see its [model card](https://huggingface.co/Remek/basal-omni-pico-GGUF) and
[confidence documentation](https://github.com/rkinas/basal/blob/main/docs/API.md#using-the-confidence).

## Pilot acceptance

Prepare an isolated, pinned format-2 server alongside the current service, with
its own model directory and port. Measure a small public/synthetic Polish set
first, including insufficient context and requests that should be deferred.
Record model, engine, quantization, calibration hashes, decision accuracy,
coverage, p50/p95 latency and peak RAM. Check output agreement between backends.
Do not treat producer benchmark results as measurements on this host.

Promotion requires useful latency and held-out accuracy within the host's memory
budget, visible uncertainty, a reversible configuration switch, and the existing
operator authorization boundary. The long-term success criterion is dependable
behaviour and preserved memory across model changes.

## Native parity contract — 2026-10-28

The parity change applies the Node probability/type/defer validation
to the native Rust client, adds a 64 KiB pre-decode body cap, sanitizes backend
errors and renders the validated auto flag directly in the TUI summary.
Both adapters resolve a service-specific advisory default per request (explicit
caller policy wins, fallback 0.93). Discovery is bounded to five seconds within
the overall request deadline, with no permanent process cache. A reported
model mismatch discards the health threshold; separate HTTP requests cannot
prove atomic model identity during a concurrent swap, so this remains advisory.

A shared public fixture checks choice, Boolean, ordinal and uncertainty cases.
The existing Rust sorted-object representation differs from JavaScript insertion
order. Score objects therefore require explicit ordinal keys 0..n-1 on both
surfaces; the Node array form maps descriptions to those positions. Named score
objects without explicit ranks are rejected rather than silently reordered.
Shared cases reject both insertion orders of ambiguous named keys. Workspace
serialization and its persisted-data contract remain untouched. Protected Rust edits require the
canonical manifest's conscious operator authorization and mcode workflow.

The shared synthetic fixture yields the same accept/reject and advisory-auto
verdicts in Node and Rust. Local verification passed 196 native unit tests plus
one canonical-hash integration test; the live model probe and a doc example
remain ignored. The native executor regression checks that high-confidence
deferral is still displayed as auto=false. A local HTTP regression verifies
that the deadline remains active after response headers arrive. No real model
classification or Pico activation is part of these tests.
