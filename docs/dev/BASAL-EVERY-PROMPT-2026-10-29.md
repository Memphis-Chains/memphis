# Automatic Basal prompt classification — 2026-10-29

The operator requested active Basal classification of every prompt. The chat
runtime now attempts one local intent classification before the first dialogue
provider call. The validated result is supplied to the answering model as
context, rather than depending on the model to request `memphis_classify`.

This covers nonempty user turns in CLI chat/ask, the Telegram gateway, canonical
HTTP chat and the native Rust operator. Tool-result iterations do not classify
the user again. Control commands that do not enter a dialogue turn and explicit
`provider-only` diagnostics keep their separate paths; they are not user turns
through the canonical chat runtime.

Session control commands such as `/context` do not classify.

In `ask --session`, a narrow exact request for the immediately preceding user
message in Polish or English can be answered from that session without a dialogue-provider call,
provided the surface allows memory recall and a prior message exists. Basal is
still called once when enabled, but this deterministic shortcut does not depend
on its verdict; the ordinary output guard still applies. Missing history or an
ambiguous request follows the normal model path. The shortcut applies to CLI
ask sessions only, not to the native TUI or other channels.

## Intent and use

The same fixed question and alphabetically ordered criteria are used by Node
and Rust. This also lets identical requests share the service's exact cache.

| Intent         | Meaning                                                 |
| -------------- | ------------------------------------------------------- |
| `clarify`      | An incomplete or unclear request                        |
| `conversation` | Conversation, greeting, general question or explanation |
| `correction`   | Correction or withdrawal of a prior fact or preference  |
| `execute`      | A request to perform a concrete action                  |
| `recall`       | Recall of previous conversations, facts or agreements   |
| `remember`     | An explicit request to remember something new           |

The model receives `<basal_prompt_classification>` with the actual verdict,
confidence, threshold and uncertainty. Confident labels add static intent
guidance; uncertain labels are explicitly weak hints. They never replace the
independent input-risk classification or grant tool, memory or operator
permissions. Existing consent and surface-policy checks still decide writes.

An invalid distribution, unavailable/overloaded service or expired deadline
produces `status: unavailable`, with no invented label or confidence. Dialogue
continues with an explicit unavailable annotation. Native cancellation aborts
the turn promptly while its bounded HTTP worker finishes independently.

## Configuration

`MEMPHIS_BASAL_PROMPT_ENABLED` defaults to `false` for installations without a
local classifier. Enable the operator's installation using the canonical
`memphis_config_set` operation:

```json
{ "key": "MEMPHIS_BASAL_PROMPT_ENABLED", "value": "true" }
```

`MEMPHIS_BASAL_PROMPT_TIMEOUT_MS` defaults to 60000, including response reading
and threshold discovery; valid integer values are 1000 through 300000.
The endpoint is the existing `MEMPHIS_BASAL_URL`, defaulting to
`http://127.0.0.1:8000/v1/systemone`. Automatic classification accepts loopback
HTTP(S) only, without credentials/query/fragment, and never follows redirects.
The manual classification tool retains its separately permissioned behavior.

Use the existing config API to disable the feature with value `false`.
Deploy the new Node compilation and native TUI executable before enabling it.
An already running native process must be reopened to load the new executable;
its configuration is read through the operator runtime's config snapshot.
Configuration changes go through Memphis APIs, not manual `.env` edits.

## Size, metadata and evidence

Intent classification receives at most 1024 UTF-8 bytes, preserving the head
and tail with an explicit shortening marker. A partial input always makes the
hint uncertain. The answering model still receives its normal original input;
this classifier budget is separate from the existing dialogue context budget.

The result records the full trimmed input's SHA-256, original/classified byte
counts, truncation and elapsed time. HTTP/CLI telemetry and the native exchange
expose `basalPromptClassification`. Structured events use
`basal.prompt.classified`. Classification metadata contains no prompt text,
arbitrary backend error body or credentials. Native audit events use the
canonical chain writer.

Local verification passed 220 native unit tests plus the canonical-hash
integration test and 120 distinct Node tests. Node checks covered classification, the existing turn runtime,
probability/native contracts, config controls and CLI paths. Shared fixtures
check the exact question, options, guidance and shortening contract.

An isolated end-to-end control used the real installed `basal-1.5-mini` and a
scripted dialogue responder, not a second classifier or real provider key.
The same synthetic recall prompt was sent through Node CLI, native Rust and
the Telegram messages path. Each made one classification request and supplied
the annotation before answering; the normalized request bodies were identical.
The native and subsequent Node requests were confirmed service cache hits.

The observed label was `recall`, confidence 0.8920716668910214, against the
service's advisory threshold 0.9546241492914076, so all paths reported
`uncertain: true`. The first Node turn took 30.13 s; cached native and subsequent
Node classification calls took 9 ms and 87 ms respectively. These observations
do not establish domain accuracy, a calibrated error rate or general latency.
No operator conversation or chain was used for the synthetic controls.

Source, test logs, exact requests, responses and deployment receipts are kept
under `/home/memphis/runtime-archives/basal-every-prompt-2026-10-29/`.
