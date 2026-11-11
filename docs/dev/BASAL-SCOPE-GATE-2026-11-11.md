# Basal scope gate: measured cost and value of the automatic prompt hint

Date: 2026-11-11. Host: i3-2120 (2 cores / 4 threads, AVX only, no AVX2),
15 GB RAM, `basal-1.5-mini` Q8_0 via llama.cpp on `127.0.0.1:8000`.

## What the automatic hint cost

Measured on this host, 99 recorded `basal.prompt.classified` events
(2026-10-29 → 2026-11-10):

| Metric                                              | Value                                         |
| --------------------------------------------------- | --------------------------------------------- |
| Classification latency                              | median **27.2 s**, p95 **60.0 s**, max 62.4 s |
| Below the calibrated threshold                      | **89 / 93** (`uncertain`)                     |
| Above the calibrated threshold                      | **4 / 93**                                    |
| Intent distribution                                 | `clarify` 89, `execute` 4, `conversation` 2   |
| Actionable intents (recall / remember / correction) | **0**                                         |
| Timeout rate (60 s deadline)                        | 5 / 99 (5.1 %)                                |

A turn took 32.6 s median; the paired turn-minus-classification median was
8.9 s. The classification was therefore roughly two thirds of the turn.

The prompt itself explains the cost. Measured token budget of the rendered
prompt (212 tokens total, prefill throughput 9.5 tok/s):

| Part                                     | Tokens |   Share |
| ---------------------------------------- | -----: | ------: |
| Six criteria descriptions                |     79 |    37 % |
| System prompt (basal format)             |     40 |    19 % |
| Chat template + answer prefill           |     26 |    12 % |
| Question                                 |     10 |     5 % |
| **The user's message** (median 25 bytes) | **15** | **7 %** |

So 93 % of the prompt is fixed scaffolding, and the cost is prefill of that
scaffolding, not the size of the message. The median message was 25 bytes
while the median prompt was 212 tokens.

## What the hint was worth

An `uncertain` hint renders as _"The hint is uncertain or partial. Interpret
the original message normally; do not force this label"_. In 96 % of turns
that is the whole instruction, so the turn paid 22–27 s of CPU for a hint
that changed no decision.

On 61 real operator turns (matched to the recorded classifications by
`contentHash`), only **4** (7 %) mention memory or a correction at all:
`co wisi?`, `otwarte`, `co pozostaje?`, `status`.

## Measured alternatives (all on this host)

| Variant                                                          | Accuracy (18 labelled cases) |              Latency |
| ---------------------------------------------------------------- | ---------------------------: | -------------------: |
| V1 current criteria                                              |                    **12/18** |                 22 s |
| V3 short criteria                                                |                         9/18 |                 18 s |
| V4/V4B action-word criteria                                      |                         1/18 |                 36 s |
| Q8 → Q4 weights (same prompt)                                    |                            — |      21.7 s → 13.0 s |
| `orders` 1 → 2                                                   |                            — |          26 s → 58 s |
| `n_threads` 3 → 4, `n_batch` 64, `n_ctx` 512, `logits_all=false` |                            — | no measurable change |

Shortening the criteria buys 18 % of the time for 25 % of the accuracy and
was rejected. Action-defined criteria collapsed onto one label and were
rejected. Word-boundary order was tested and produced identical verdicts, so
the collapse was not a position bias.

`basal-omni-pico` was measured as a faster candidate: 7–12 s per call, but
0/6 on the `clarify` group with these criteria — it is a different taxonomy,
so it was rejected for this use.

## The change

`MEMPHIS_BASAL_PROMPT_SCOPE` selects what is classified:

- `every` (default) — the previous behaviour: every nonempty user turn.
- `actionable` — only turns that can still need a memory or correction
  intent. The gate is a cheap substring pre-filter, not a classifier: it
  decides whether to spend the CPU, and the verdict still comes from the
  model.

Both arms (TypeScript gateway and the native Rust operator) implement the
same gate, and `tests/fixtures/basal-prompt-scope.json` pins the cue table
and 38 expected decisions for both.

Matching is plain case-insensitive substring containment in both arms on
purpose. JavaScript's `\b` treats Polish letters as non-word characters while
Rust's `is_alphanumeric` does not, so a word-boundary rule would answer
differently in the two arms on the same message. Substring matching errs
towards classifying more often, and a needless classification only spends
CPU; a missed one would drop a hint that could have changed a decision.

## Measured effect on this host

Live, against the running service, using the built distribution:

| Turn                                           |  `every` |           `actionable` |
| ---------------------------------------------- | -------: | ---------------------: |
| `wyślij mi raport na telegram`                 | 22208 ms |     **1 ms** (no call) |
| `opisz jak basal zmienil memphis…`             | 23114 ms |     **0 ms** (no call) |
| `co ustaliliśmy wczoraj o bazie semantycznej?` | 22940 ms | classified (cache hit) |
| `nie, chodziło mi o BGE-M3…`                   | 23362 ms | classified (cache hit) |

A memory turn that the service had not cached still cost 23 s — the gate
removes the wait where the hint could not change a decision, and keeps it
where it can.

The operator's installation enables `actionable` through the canonical
config API (`runMemphisConfigSet`), not by editing `.env`.

## What this does not prove

The automatic hint has never produced an actionable verdict on this host
(0 of 100 recorded classifications). The gate therefore removes a measured
cost from turns that were unlikely to benefit, and keeps the feature
available for the turns where it might. It is not a proof that the
remaining 7 % of turns benefit — that needs a paired comparison of answers
with and without the hint, which has not been run.
