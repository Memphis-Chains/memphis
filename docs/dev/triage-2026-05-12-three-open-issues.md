# Triage 2026-05-12 — three open issues seeking Codex input

This doc captures three reproducible-but-not-yet-fixed concerns that
surfaced during the v1.10.0 stabilization sprint. Pushing as a PR
specifically to invite Codex review on the proposed approach for each
— if you have a sharper idea than what's below, please flag it on the
respective section.

---

## 1. memphis-napi Rust lib test fails on CI but passes locally (P2)

### Symptom

Release-gate `testRust` step exits 101 on the GitHub Actions runner.
Repro: every release-gate run from v1.9.1 (2026-05-08) through v1.10.0
(2026-05-12 13:46). Always on `memphis-napi --lib`, never on the
TS-side test bucket. Last line of CI stderr:

```
warning: `memphis-napi` (lib test) generated 8 warnings
Compiling memphis-tui v0.1.0 (/home/runner/work/memphis/memphis/crates/memphis-tui)
 Finished `test` profile [unoptimized + debuginfo] target(s) in 14.50s
  Running unittests src/lib.rs (target/debug/deps/memphis_napi-771e90b1143ef683)
error: test failed, to rerun pass `-p memphis-napi --lib`
```

CI doesn't surface which test panicked — just the exit code.

### Local repro attempt (2026-05-12 17:54)

```
$ cargo test -p memphis-napi --lib
running 20 tests
test tests::case_append_rejects_invalid_entry ... ok
... [20 more] ...
test result: ok. 20 passed; 0 failed; 0 ignored
```

**Cannot reproduce locally** on the operator's Linux box (same arch).

### Hypotheses

1. CI environment exposes a Node version / linker / glibc variant that
   the Rust binding loads at test time. The `memphis_napi` test binary
   does a `node-bindgen`-style `.node` load to exercise vault adapter
   helpers; a mismatched dynamic loader on the runner could panic
   only at test-startup time but pass once compiled.
2. Concurrent test isolation: a fixture that shells out to
   `vault init` writes to a hardcoded `$HOME/.memphis/` path and
   races itself when parallel tests share the runner's working dir.
3. Flaky filesystem timing (tmpfs vs ext4 in CI).

### Proposed fix path

- Plumb a `--nocapture --test-threads=1` invocation through
  `npm run test:rust` so CI emits the panicking test's stdout. Without
  the panic text, every theory is speculation.
- Once the failing test is named, audit it for `$HOME/.memphis/` /
  hardcoded path use — if any, swap to `tempfile::TempDir`.

### Question for Codex

We **think** this is environmental, not a real test bug. But the same
class of "passes locally / dies on CI" failure has hidden real bugs
before. Does the surface you can see (the 20-test list above + the
shape of `memphis-napi` bindings) suggest a specific test that's the
likely culprit? Particularly: any test that touches `cwd` /
`env::current_dir()` / a static `OnceCell` that would behave
differently on a fresh runner vs a long-lived dev shell?

---

## 2. Insights chain blocks exceed embed pipeline's 4096-byte limit (P3)

### Symptom

Daemon log noise from `embed-reindex`:

```
[embed-reindex] 38 block(s) skipped due to embed errors; first 5:
  chain=insights index=3 err=embed_store_failed: text too large: 8970 bytes exceeds max 4096
  chain=insights index=4 err=embed_store_failed: text too large: 8970 bytes exceeds max 4096
  chain=insights index=5 err=embed_store_failed: text too large: 10028 bytes exceeds max 4096
  chain=insights index=6 err=embed_store_failed: text too large: 8970 bytes exceeds max 4096
```

5 instances in last 4 hours (after PR #573 daemon restart). Recurring
since the daily insight reflection loop produces 8-10 KB blocks (JSON
dump of `insights[]` array). The Rust embed pipeline rejects anything
above `DEFAULT_MAX_TEXT_BYTES = 4096`
(`crates/memphis-embed/src/pipeline.rs:64`).

### Why it matters

Each rejected insight block is unsearchable via semantic recall —
operator asks "co Memphis odkrył w insights" and the answer skips
38 blocks of real material. Silent loss.

### Two candidate fixes

**A. Truncate at the embed-reindex layer (TS-side, simple)**

```ts
// In embed-reindex.ts, before pushing into `prepared`:
const text = entry.content.length > 4000
  ? entry.content.slice(0, 4000) + '\n[truncated for embed]'
  : entry.content;
```

Pros: minimal change, single file, no API churn.
Cons: search recall against full insight content is degraded — the
later 60% of a 10-KB insight is invisible to semantic search.

**B. Chunk + multi-vector per block (TS-side, better recall)**

Split text >4000 bytes into 4000-byte chunks with 200-byte overlap;
emit one embed item per chunk with a `subindex` tag; aggregate at
search time (max-pool or mean).

Pros: full recall coverage.
Cons: requires changes in `embedSearch` to deduplicate hits by
`block.index` (so a block doesn't dominate ranking N-fold), and
storage cost grows ~Nx for long blocks.

### Question for Codex

Lean towards (A) or (B)? Memphis's insight blocks are typically
8-10 KB (per the live samples above). Search recall pattern is:
operator asks a high-level question, top-K = 5. With 38 blocks
already truncated and recall behaviour the operator hasn't
complained about explicitly, is the recall degradation in (A)
acceptable, or is the dedup work in (B) worth doing now?

A third option — bump `DEFAULT_MAX_TEXT_BYTES` to 16 KB and let
the all-minilm-384 embedding model handle the longer input — was
ruled out by the model card (max sequence ~512 tokens ≈ 2 KB text;
anything past that gets truncated inside the Rust pipeline
already). So bumping the limit just moves the silent truncation
into the inference path.

---

## 3. Daemon SIGSEGV during shutdown path (P0 stability)

### Signature

Eight SIGSEGV events captured today between 15:19 and 18:15 (≈3 hrs).
After installing `systemd-coredump` + bumping `LimitCORESoft=infinity`
at 15:21, **5 of the 8 crashes preserved cores**. All 5 preserved
cores show **identical signature**:

```
Stack trace of thread <PID>:
#0  0x0000000000000000 n/a   ← SIGSEGV: NULL pointer dereference
#1  0x00007*****5e2 n/a       ← V8 JIT-compiled frame
#2-10  0x00007***** n/a       ← more JIT frames
#11 0x0000000001382683 _ZN2v88internal12_GLOBAL__N_16InvokeEPNS0_7IsolateERKNS1_12InvokeParamsE
```

Frame #1 offset `…5e2` is consistent across all 5 cores (different
ASLR base, identical relative offset within the V8 binary). That's a
**deterministic crash signature** — same JIT-compiled function dies
each time — not a race.

### When it fires

Pattern from coredumpctl + journalctl:

| Time | PID | Trigger | Core preserved |
|---|---|---|---|
| 15:19 | 262953 | normal shutdown (systemctl restart) | none (pre-RLIMIT-CORE fix) |
| 15:47 | 265838 | runtime crash after ~12 min uptime | ✅ 26 MB |
| 15:52 | 265881 + 265965 | orphan worker child processes died | none |
| 16:04 | 288308 | shutdown (systemctl restart) | ✅ 22 MB |
| 16:15 | 291249 | shutdown | ✅ 18 MB |
| 17:40 | 292398 | shutdown | ✅ 18 MB |
| 18:15 | 295838 | shutdown (systemctl restart) | ✅ 22 MB |

**4 of 5 preserved crashes are during shutdown.** The 15:47 one is
the only runtime crash; the rest are graceful-stop attempts that
SIGSEGV before the process can exit cleanly. systemd auto-restarts
each time so the daemon comes back, but every `systemctl restart`
leaves a coredump trail.

### Hypothesis

The shutdown path is async — multiple native bindings teardown in
some order. `Node v22` + `onnxruntime-node@1.21` + `better-sqlite3@12`
+ `memphis-napi` (Rust) + `@huggingface/transformers` are all loaded
when kartograf is active. One of them is double-freeing or holding a
JS-side wrapper that gets invalidated mid-teardown, the V8 GC tries
to walk the wrapper, NULL deref.

The 15:47 runtime crash had the operator using Telegram → many
memphis_exec calls → child-process subprocess spawn/wait loop.
shutdown crashes have no such trigger — they're just the
SIGTERM-handler running through native binding `release` calls.

### Proposed approach

Two ladders:

**(i) Cheaper diagnosis first.** Add `process.on('beforeExit', …)` +
`process.on('exit', …)` logging that names the last native binding
to be closed. If 5/5 crashes show the same last-closed binding, we
have the suspect.

**(ii) Symbolize the V8 frame.** Run Memphis once under `node --prof`
(real flag — Codex review #585 caught that `--enable-extra-features`
doesn't exist), trigger a shutdown SIGSEGV, then post-process the
resulting `isolate-*-v8.log` with `node --prof-process isolate-*.log`.
That materializes a symbol map for the JIT addresses; the
`0x...5e2` offset should resolve to a named bytecode handler when
paired with Node's debug build. Requires the Node dev symbols
(Ubuntu `nodejs-dbgsym` or `--debug` build from source) for full
names; without them the profile still surfaces the ratio of time
spent in each native binding's teardown path, which is enough to
bisect.

### Question for Codex

The shutdown-only pattern (4 of 5 preserved cores during graceful
stop, not during runtime) strongly suggests teardown order, not a
runtime UAF. Has this class of failure shown up before in Memphis
or in Node-NAPI stacks you've seen? Common culprits I'm aware of:

- `better-sqlite3`: `db.close()` after the prepared-statement cache
  is already finalized.
- `onnxruntime-node`: `session.release()` while a tensor view is
  still held by JS.
- `memphis-napi` (Rust): a `napi::Env`-bound callback fires during
  teardown after the JS environment is gone.

Does any of those match `…5e2` as a V8 JIT entry point you can
recognize? If not, what's the cheapest way to bisect — disable
kartograf, disable onnxruntime-node import entirely, see if the
shutdown crash goes away?

---

## How to respond

This doc lands on `triage/three-open-issues-2026-05-12` as a single
file. If you have answers, drop them as PR comments — happy to spin
each into its own fix-PR with the suggested approach.
