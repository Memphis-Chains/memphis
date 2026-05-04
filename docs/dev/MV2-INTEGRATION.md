# `.mv2` integration — scaffold + memvid-core upgrade path

> Sprint G (Y1 Q1 N12) • 2026-05-04 • crate: `crates/memphis-export/`

## Why a scaffold, not memvid-core 2.0 directly

memvid-core 2.0.139 is the canonical encoder we want for `.mv2`. It pulls
in tantivy + candle + ort + symphonia + ~50 transitive deps and requires
Rust 1.85. The Memphis workspace currently pins:

- `onnxruntime-node` for Kartograf inference (clashes with `ort`'s
  pin choices and sub-feature gating)
- `memphis-tui` cold builds in <30s today; pulling memvid-core takes
  it past 4 minutes on the demo box
- TUI binary currently 22 MB; memvid-core stack would ship a 200 MB+
  binary that's a no-go for the LAN deploy package

The Sprint G scaffold therefore implements an in-house **v0** container
with the same high-level layout (magic, version, track table, frames)
so the Q1 exit gate (`cargo test -p memphis-export -- mv2_roundtrip_minimal`)
ships now and the swap to memvid-core 2.0.x stays a localized change.

## v0 container layout

| Offset | Bytes | Field         | Notes                                        |
|-------:|------:|---------------|----------------------------------------------|
|      0 |     4 | magic         | `b"MV2\0"`                                   |
|      4 |     4 | version       | `u32 LE`; v0 = 0                             |
|      8 |    32 | body_sha256   | sha-256 of all bytes ≥ offset 44             |
|     40 |     4 | frame_count   | `u32 LE`                                     |
|     44 |   ... | frames        | length-prefixed, see below                   |

Frame layout:

| Bytes | Field         | Notes                                          |
|------:|---------------|------------------------------------------------|
|     1 | track         | `u8` — 0=journal, 1=chains, 2=embeddings, 3=vault (denied) |
|     4 | id_len        | `u32 LE`                                       |
| id_len| id_bytes      | UTF-8                                          |
|     4 | payload_len   | `u32 LE`                                       |
|payload_len | payload_bytes | UTF-8 JSON                                |

Vault track is reserved on the wire but the writer rejects it at
runtime — vault export goes through `memphis vault export` which
preserves the encryption envelope.

## TS → NAPI surface

```ts
// src/infra/cli/commands/export-mv2.ts
import { mv2_export, mv2_inspect } from "../../storage/napi-contract.js";

const records = [
  { track: "journal", id: "j-1", payload: { ts: "...", text: "..." } },
];
const result = mv2_export(JSON.stringify(records), JSON.stringify(["journal"]));
// → { ok: true, data: { frame_count: 1, bytes_hex: "4d563200..." } }
```

The NAPI bridge returns `bytes_hex` rather than a Node `Buffer` so the
contract stays platform-stable across napi-rs versions; the TS layer
decodes to `Uint8Array` before `fs.writeFile`.

## Operator surface

```bash
# Q1 acceptance
cargo test -p memphis-export -- mv2_roundtrip_minimal

# CLI smoke (after `npm run build`)
memphis export --format=mv2 --output /tmp/j.mv2 --include journal
test -f /tmp/j.mv2 && echo "ok"

# Inspect via NAPI bridge (programmatic)
node -e 'const {mv2_inspect} = require("./crates/memphis-napi/index.node");
const buf = require("fs").readFileSync("/tmp/j.mv2");
const hex = Buffer.from(buf).toString("hex");
console.log(mv2_inspect(hex));'
```

## Upgrade path → memvid-core 2.0.x

Trigger conditions for the swap (any one is sufficient):

1. Memphis adopts the GPU encoder pipeline (memvid frame compression
   needs `cuda` or `metal` features; Kartograf already consumes our
   GPU budget on the demo box, so this lands after Kartograf training
   moves to cloud H100).
2. Operator demand for cross-runtime `.mv2` interop (other memvid
   ecosystems reading our exports). Today's audience is Memphis-only.
3. v0 frame count caps bite — current writer materializes the whole
   container in memory.

Migration plan:

| Step | Change                                                              |
|-----:|---------------------------------------------------------------------|
|    1 | Add `memvid-core = { version = "2.0", default-features = false }` to `crates/memphis-export/Cargo.toml`. |
|    2 | Replace `mv2::writer::Mv2Writer::finish` with memvid-core's frame encoder, keeping the same input shape (`&[Mv2Record]`). |
|    3 | Bump `MV2_VERSION` to `1`. Add a `v0` shim in the reader so existing exports still round-trip. |
|    4 | Vendor memvid-core to `vendor/memvid-core/` for offline builds. Document the pin in `DEPENDENCY-POLICY.md` (`stable-platform: Apache-2.0, frame codec, 2.0.x pinned, fallback to vendor/ documented`). |
|    5 | Drop the in-house `mv2::writer` once two minor releases have shipped both formats. |

## Why no compression in v0

Operator journal is typically <50 MB raw JSON. `gzip` on top of UTF-8
JSON gets ~5x; that's a follow-up flag (`--compress=zstd`) once an
operator complains about file size, not v0 surface area. The on-disk
`body_sha256` is computed over uncompressed bytes so adding a
compression layer is a strict superset.

## Why no encryption in v0

Vault entries are explicitly denylisted. Other tracks (journal, chains,
embeddings) are user-readable runtime state — encrypting them is the
operator's responsibility (full-disk encryption / GPG over the file).
memvid-core's `encryption` feature is the future option once we
support multi-tenant exports.

## Related

- `crates/memphis-export/src/lib.rs` — public surface
- `crates/memphis-export/src/mv2/{writer,reader,tracks,error}.rs` — v0 codec
- `crates/memphis-napi/src/lib.rs` — `mv2_export` + `mv2_inspect` exports
- `src/infra/cli/commands/export-mv2.ts` — CLI handler
- `~/.claude/plans/kind-splashing-willow.md` (Sprint G section) — sequencing rationale
