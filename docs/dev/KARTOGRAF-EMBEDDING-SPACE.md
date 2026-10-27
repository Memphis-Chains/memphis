# Kartograf embedding space contract

The runtime binds each real session and inference result to an embedding
space. Matching dimensions alone do not establish compatibility: a different
model or tokenizer can produce unrelated coordinates with the same shape.

| Identifier           | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| Installed bundle ID  | Hash of the complete signed envelope, including release metadata |
| Model `checkpointId` | SHA-256 of the actual ONNX bytes                                 |
| Embedding space ID   | `kartograf:` plus SHA-256 of canonical space metadata            |

Space metadata includes its schema version, provider, model and tokenizer
hashes, declared embedding dimension, `f32` dtype, explicit tokenizer policy
and `model-output` transform. It is derived from verified checkpoint metadata.
Resigning identical artifacts does not change their space; changing model,
tokenizer, dimension or preprocessing policy does. This is an identity boundary,
not an evaluation score or a claim that retrieval is integrated.

The current tokenizer policy constructs `PreTrainedTokenizer` directly from
the hash-verified `tokenizer.json` byte snapshot. It uses no padding and truncates
to 512 tokens. The model's JSON defines normalization, vocabulary, added tokens
and postprocessing. Unsigned `tokenizer_config.json` and other sidecars are not
read, no remote configuration is fetched, and loading does not modify the bundle.
Models that relied on unsigned overrides need a new evaluation against this
explicit policy. A dependency/preprocessing change that alters tokenization must
bump the policy and produce a different space ID.

ONNX outputs must be float32 tensors with exact `[1, embedding_dim]` and
`[1, zone_classes]` shapes and matching element counts. All values must be finite;
zero embeddings are rejected. The loader never pads or truncates output tensors.
Activation, CLI and MCP additionally check model/space identity, vector shape and
zone validity at their consumer boundaries. Malformed output produces a failure
without exposing underlying inference diagnostics.

CLI status reports selected and active spaces separately. Query and MCP outputs
include the verified space metadata. Tensor status reads a metadata snapshot of
the cached runtime without initializing a model. A feature flag or an environment
checkpoint ID cannot make it claim that an ONNX model is loaded; desired IDs are
reported separately from actual runtime IDs.

## Native index and cascade boundary

The current native store/search API accepts text and performs its own embedding.
Its persisted index headers identify dimensions but do not bind model/tokenizer
space identity. This change does not write, migrate or claim compatibility with
those indexes. Native index/cascade integration remains pending.

The next native boundary must persist and verify the full space identity for
both insertion and query, refuse unbound legacy indexes for Kartograf vectors,
and keep incompatible spaces separate. Fallback must select an independently
built compatible index; it must not mix providers inside one vector space or pad
one model's vectors to fit another. The implementation must expose actual
provider/index readiness before doctor can report Kartograf as tier 0.

No checkpoint is manufactured or activated by this contract. Real signed model
artifacts, evaluation, the zone schema and independent review remain required.
