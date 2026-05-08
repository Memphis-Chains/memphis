---
name: memphis-rebuild-rust
description: Rebuild Memphis NAPI binary after Rust crate changes and verify the runtime will see the new code. Use whenever crates/memphis-{core,operator,napi,vault,tui,case-index,embed}/ source has been modified.
allowed-tools: Bash, Read
paths:
  - "crates/**/*.rs"
  - "crates/**/Cargo.toml"
---

# Rebuild NAPI binary after Rust crate changes

The TS host loads the compiled `crates/memphis-napi/index.node` at module-load time and ESM caches it. Rust source edits are silent until the binary is rebuilt — this is the #1 source of "I changed the code but Memphis still behaves the old way" reports.

## When to run this skill

Trigger automatically (via the `paths:` glob) any time a `crates/**/*.rs` file is modified in the session. Trigger manually:

- After `git pull` that includes Rust crate changes (CI builds artifacts upstream but local checkouts ship source-only)
- After landing a hotfix that touched a crate
- When the operator reports "Memphis isn't picking up my fix"

## Steps

### 1. Sanity-check the source/binary delta

```bash
ls -la crates/memphis-napi/index.node
git log --format='%h %ai %s' -1 -- 'crates/**/*.rs'
```

If the latest Rust commit timestamp is **after** the binary's mtime, the runtime is stale. Proceed.

### 2. Build the workspace

```bash
npm run build:rust 2>&1 | tail -10
```

Confirms no compile errors. The script (`scripts/run-rust.sh`) builds all crates in workspace and copies the NAPI shared library into `crates/memphis-napi/index.node`.

### 3. Verify the binary moved

```bash
ls -la crates/memphis-napi/index.node
```

Mtime must be later than the latest Rust commit timestamp from step 1. If unchanged, the build silently failed — re-run with `--release` or check `target/debug/libmemphis_napi.so` exists.

### 4. Tell the operator they need to restart

The TS host process loads `.node` once at startup. A running `memphis serve` / TUI session will keep using the old binary in memory. Inform the operator:

> Rebuild done. If Memphis is currently running, it needs a restart to pick up the new binary — `pkill memphis` (or close the TUI) then start fresh.

### 5. Optional: run targeted tests

If the change touched `provider.rs`, `chat.rs`, or `loop_engine.rs`:

```bash
cargo test -p memphis-operator --lib provider:: 2>&1 | tail -20
cargo test -p memphis-core --lib loop_engine:: 2>&1 | tail -20
```

## Anti-patterns

- **Don't** assume the binary is fresh because compilation finished. The script silently exits 0 even if the copy step is skipped — verify mtime.
- **Don't** suggest `--release` reflexively. Debug builds are 5–10× faster to iterate; release is for tagged versions.
- **Don't** forget restart messaging. Building without restarting = same effect as not building.

## Reference memories

- `feedback_napi_rebuild_after_rust_changes.md` — root-cause documentation
- `feedback_truth_model_silent_catch.md` — same family ("what's actually running ≠ what source says")
- `feedback_install_root_anchoring.md` — same family for path resolution
