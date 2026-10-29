# Basal native audit made runtime health unhealthy — 2026-10-29

The native TUI's automatic Basal classification, added in PR #714, exposed an
older audit writer that persisted `security_event` payloads without canonical
`content` and `tags`. The first observed live event was `system/011476.json`,
written at 16:58:36 UTC. The first-run scanner then reported legacy state and
`GET /health` returned HTTP 503. Basal itself, SQLite, embeddings and recall
remained available. A valid canonical hash alone did not establish that the
serialized payload satisfied every reader's schema.

`audit_basal_prompt_classification` called `emit_runtime_security_event`, the
same helper used by input and output guards. Using the chain append primitive
ensured locking and hashes, but that primitive deliberately accepts generic
data and does not add the required BlockData fields. Earlier tests verified
the verdict, model annotation, cache and response contract without running the
first-run scanner against the resulting native audit chain.

The shared native audit helper now writes `system_event`, retaining the
`security_event` meaning in `kind` and preserving existing structured audit
fields. It serializes the sanitized event into `content` and supplies string
tags, so the canonical hash also covers the audit details. This fixes Basal,
input-risk and output-redaction callers together without changing their gates.

Regression tests deserialize emitted events through the canonical Rust Block
type, validate chain hashes and links, and check that Basal metadata remains
inside the hashed content. An isolated control also sends a prompt through
the compiled native example and then runs the production Node first-run
scanner against its audit output. Before the fix it detects legacy state;
the fixed writer must leave the scan clean. Providers are local fixtures in
this control; no operator chains or credentials are used.

Recovery uses a verified backup and Memphis's canonical runtime repair under
the shared system-chain write lock. Existing native processes must load the
fixed executable before they can write more events. Original audit data is
retained in the backup; normalization may change hashes of the affected block
and its successors. The initial live metadata audit found one malformed block
and no signed system blocks. Deployment and repair receipts, including the
final health result, are kept outside the repository at
`/home/memphis/runtime-archives/basal-audit-schema-2026-10-29/`.

This is related to the earlier [invalid block shape incident](2026-09-22-chains-halt-invalid-block-shape.md):
every persisted writer needs a reader-contract test, including audit writers.
