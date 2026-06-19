# Memphis Tensor Architecture

Memphis does not expose raw model tensors as a public API. Operator surfaces expose tensor metadata, search scores, and previews; raw vectors stay inside Rust/ONNX runtime code.

## Runtime Shapes

- Memory/search embeddings are one-dimensional dense `f32` vectors in Rust: `Vec<f32>`.
- Kartograf embeddings are TypeScript `Float32Array` values, normally 256 dimensions.
- ONNX runtime tensors exist only inside Kartograf inference: token inputs are `int64` tensors and outputs are `Float32Array` buffers for `embedding` and `zone_logits`.
- Search surfaces expose scalar scores, not vectors.

## Dimension Truth

- `RUST_EMBED_DIM` controls memory/search embedding dimension. Default: `32`.
- Kartograf checkpoint `heads_config.embedding_dim` controls Kartograf output dimension. Default v1: `256`.
- Historical embed indexes may contain another `dim` such as `768`; treat that as legacy state requiring reindex, not as the active default.

## Surface Policy

Public, MCP, Telegram, TUI, and CLI surfaces must not return raw vector values by default. They may return:

- `dim`
- `dtype: "f32"`
- `provider`
- `normalized`
- `persistenceEnabled`
- `persistenceLoadState`
- `score`
- `text_preview`

Use `memphis tensor status --json` or `memphis_tensor_status` to inspect the active tensor configuration.
