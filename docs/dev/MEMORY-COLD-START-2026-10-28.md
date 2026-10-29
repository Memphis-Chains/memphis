# Memory continuity and source content — 2026-10-28

A correction could be safely stored and found after restart while the chat
model still answered the superseded fact. The semantic adapter returned the
embedding index's short `text_preview`, and the Node chat prompt then limited
each recalled item to 300 characters. The actual correction could be absent
from both. Native TUI recall also returned the vector preview to the model.

The fix resolves semantic hits to their stored source content before scanning
or handing them to chat. Source references and hashes accompany resolved
results. The Node prompt admits up to 4,000 characters per item and 12,000
characters total, explicitly marking entries shortened to fit. Native TUI
tool output retains its short UI preview and supplies the source content in a
separate field. This does not reconstruct text intentionally omitted by a
writer before the block was stored.

## Acceptance setup

Each Node worker starts as a separate process, with a fresh module/native
state and an explicit isolated temporary home, chain directory, SQLite DB,
embedding path and empty config file. No operator environment or credentials
are inherited. Writes use the canonical journal API. Rust NAPI is required;
the tests fail rather than silently switching to the legacy backend.

The deterministic 32-dimensional embedding backend is used to verify storage
and reconstruction, not semantic retrieval quality. Sources and hashes are
compared with the canonical chain after process exit. Synthetic facts include
an original deadline, an explicit correction, and a different user's deadline.

The checked-in integration tests verify:

- Retrieval in a fresh process after the writer exits.
- The original hash and correction history remain intact.
- A correction beyond the old vector-preview and 300-character prompt limits
  actually reaches each newly selected model's context.
- Another user's note is not injected into that conversation.
- An empty runtime has no recalled facts.
- A surface-policy write denial leaves the journal unchanged after restart.

CI uses scripted provider replies and inspects the real supplied context; it
does not claim that a scripted response measures language-model accuracy.
The native tests cover source content and hash in the TUI recall tool,
chunk deduplication, and unsafe preview filtering. Node tests additionally
verify that unsafe instructions beyond a safe-looking preview are filtered
after source resolution and that prompt shortening is explicit and bounded.

## Live model control

Two already-installed Ollama models were run through the actual Node turn
runtime, against the same isolated persistent memory. Models were unloaded
after calls; no new model weights or production settings were installed.

| Check                                           | Before correction to retrieval | After                       |
| ----------------------------------------------- | ------------------------------ | --------------------------- |
| `qwen2.5:0.5b`: current deadline code           | MON (stale)                    | TUE (current)               |
| `qwen2.5-coder:3b`: current deadline code       | MON (stale)                    | TUE (current)               |
| `qwen2.5:0.5b`: absent flight-ticket number     | invented/unrelated response    | unrelated response (`TUE.`) |
| `qwen2.5-coder:3b`: absent flight-ticket number | `BRAK_DANYCH`                  | `BRAK_DANYCH`               |

The expected current deadline was `TUE`, and the required absent-fact answer
was `BRAK_DANYCH`. The small model's failure remains a failure. The combined
initial screen improved from 10/13 to 12/13 checks; these are heterogeneous
acceptance checks, not a representative accuracy benchmark. Source recovery
fixes missing evidence; it does not guarantee a model will admit uncertainty.
Neither local model replaces the production conversational provider.

Before the first synthetic write the explicit chain verifier reports a
missing journal directory. That is a not-yet-created chain, not corruption.
Every populated synthetic chain passed integrity verification. No chain was
rewritten to apply a correction.

## Reproduce and limitations

After building the native bridge, run:

```bash
npx vitest run tests/integration/memory-cold-start.e2e.test.ts \
  tests/unit/recall-source-content.test.ts
cargo test -p memphis-operator native_recall_
```

An isolated checkout can use `MEMPHIS_TEST_NATIVE_BRIDGE` to point at an
already-built compatible binding. The child workers verify `rust-napi` and
the effective data directory before reading or writing memory. They do not
need provider tokens or network access for CI. Native Rust changes on this
host require the manifest's conscious operator grant and mcode workflow.

The source resolver reads each referenced chain once per recall and supports
the default chain/index IDs, explicit memory IDs and chunked IDs. Existing
index-only entries without a durable source retain their preview and are
identified as `contentSource: preview`; they do not gain source provenance.
Whole-content prompt scanning happens after resolution. A source hash is a
reference to the stored block; the chain verifier remains the integrity check.

The no-write scenario tests an explicit surface policy, not recognition of
every natural-language privacy request. The tests establish process-restart
continuity, not restoration after disk loss. Existing backup/restore drills
cover that separate boundary. The screen does not select an embedding
checkpoint, activate Kartograf, or assert a calibrated error rate.

Host evidence, per-process outputs, exact prompts, before/after live responses
and authorization metadata are stored in
`/home/memphis/runtime-archives/memory-cold-start-2026-10-28/`.
