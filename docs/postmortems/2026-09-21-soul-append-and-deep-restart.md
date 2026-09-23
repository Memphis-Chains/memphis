# Postmortem: manual soul chain append + deepest-possible restart

**Session:** 2026-09-21 ~21:00–23:25 CEST
**Operator:** Wodzu (Marcin)
**Memphis runtime:** memphis.service PID 8905 → 2678753 (post-restart)
**Surface:** `memphis-tui` (TUI cockpit) → backend REST API on :3000

This postmortem captures two adjacent operations performed in one session:

1. Manual append of `000256.json` to the soul chain (no CLI/MCP tool exists for this).
2. "Najgłębszy restart jaki potrafisz" — full reset of every memphis-managed daemon.

The point of writing it down is so the next session knows (a) the soul chain write path exists but is not exposed, (b) the restart sequence, and (c) what is durable vs in-memory.

---

## Part 1 — Manual soul chain append (block 000256)

### What was asked
Append an entry to the soul chain recording who released OpenClaw v0.1.0 (`https://github.com/Memphis-Chains/MemphisOS-OpenClaw/releases/tag/v0.1.0`). Conscious explicit trigger: operator said "Sprobuj zapisac do soul chain. Explicite." and then "go" after I asked for second confirmation.

### The fact that was recorded
- OpenClaw v0.1.0 = AI gateway, Layer 3 of the Memphis ecosystem (`Memphis → MemphisOS → OpenClaw → Telegram/Discord`)
- Released **2026-03-15T07:40:39Z**
- By **Memphis-Chains** (org account on GitHub)
- URL: https://github.com/Memphis-Chains/MemphisOS-OpenClaw/releases/tag/v0.1.0
- Body linki: `docs/FULL_INSTALL_GUIDE.md`, `docs/SOUL_GUIDE.md`

### What I learned the hard way
**There is no CLI/MCP tool to append directly to the soul chain.** Available writers:

| Tool | Chain written to |
|---|---|
| `memphis_journal` | journal |
| `memphis_case_append` | cases |
| `memphis_decide` | decisions |
| `memphis_soul_write` | `~/.memphis/config/soul-memory.json` (config), **not** the soul chain |
| (CLI) `memphis chain append ...` | only journal/decisions/cases/patterns/reflections — **soul is not in this set** |

The only code that writes to soul is internal: `appendBlock('soul', ...)` in `src/soul/memory.ts:412` (triggered by `appendMemoryAction` / `burnMemoryAction`). These are fired by other memory events, not by operator intent.

**To write to soul on operator request, the manual path is:**

1. Reproduce the canonical-hash algorithm. Verify by reproducing the existing last block's hash:
   ```python
   import json, hashlib
   with open('~/.memphis/chains/soul/000255.json') as f:
       block = json.load(f)
   block_without_hash = {k: v for k, v in block.items() if k != 'hash'}
   data = block_without_hash['data']
   canonical_data = {
       'type': data.get('type', 'journal'),
       'content': data.get('content') if isinstance(data.get('content'), str) else json.dumps(data),
       'tags': [t for t in (data.get('tags') or []) if isinstance(t, str)],
   }
   canonical_block = {**block_without_hash, 'data': canonical_data}
   def sort_keys(value):
       if isinstance(value, list): return [sort_keys(v) for v in value]
       if isinstance(value, dict): return {k: sort_keys(value[k]) for k in sorted(value.keys())}
       return value
   canonical_string = json.dumps(sort_keys(canonical_block), separators=(',', ':'))
   print(hashlib.sha256(canonical_string.encode()).hexdigest())
   ```
   This **must** match `block['hash']`. If it does not, do NOT write — algorithm is wrong.

2. The hash algorithm matches `stableStringify` (sort keys recursively, `JSON.stringify` no indent) + sha256, then `toCanonicalHashData` reduces `data` to the 3-field form `{type, content, tags}`. See `src/core/stable-stringify.ts` and `src/infra/storage/chain-adapter.ts:503-512`. Rust side mirror: `crates/memphis-core/src/hash.rs:5` (`compute_hash`).

3. Compose the new block with:
   - `index = prev.index + 1`
   - `prev_hash = prev.hash`
   - `chain = 'soul'`
   - `data.type` must be a `BlockType` variant. For memory/action, use `system_event` (the `memory.action` string is a serde alias for `SystemEvent` per `crates/memphis-core/src/block.rs:11-26`)
   - `data.content` non-empty (Rust validator rejects empty content)
   - `data.tags` array of strings, can be empty

4. Atomic write:
   ```python
   filename = f"{chains_dir}/{next_index:06d}.json"
   tmp_filename = f"{filename}.tmp-{os.getpid()}-{int(time.time()*1000)}"
   with open(tmp_filename, 'w', encoding='utf-8') as f:
       f.write(json.dumps(new_block, indent=2, ensure_ascii=False))
   os.rename(tmp_filename, filename)  # atomic
   ```

5. Validate with `memphis_chain_verify soul` — must return `ok:true` and `blockCount` = prev + 1.

6. Round-trip verify by recomputing hash from the new file and comparing to stored hash.

### Result of my session
- Wrote `000256.json` with hash `23fa915bbeb8a7d1b306c3bd526beb9d1632140f6c37a36bb385b8ec9fd91930`
- `memphis_chain_verify soul` → ok:true, 256 blocks
- Round-trip hash reproduce match: True
- prev_hash linkage: 256.prev (`e9c6367d...`) = 255.hash (`e9c6367d...`)

### Caveats / what's not guaranteed
- Rust NAPI backend may recompute hash on read using `serde_json::to_vec` (key order = struct field order, not alphabetic). For 3-field `CanonicalHashData {type, content, tags}` the alphabetic order matches declaration order, so it should match. **But unverified end-to-end.**
- `MEMPHIS_SOUL_STRICT` env var does not exist in current config — no signature required for `memory.action` blocks. If strict mode is turned on later, future manual appends will fail validation. Check before writing.
- The Rust `Block.data` struct is `BlockData { block_type, content, tags }` — TS-side `data` is a freeform record. The Rust strict validator reads `data.type`, `data.content`, `data.tags`. Extra fields in `data` are ignored by Rust, so including them is safe (e.g. `data.kind`, `data.source`, `data.schemaVersion`, `data.payload` are decorative).

### Decision chain reference
`decisions[221]` — full record of the manual append, including VERIFIED/UNVERIFIED.

---

## Part 2 — Deepest-possible restart

### What was asked
"Teraz zrestartuj systemy do najglebszego jaki potrafisz, a potem zobacz co przetrwalo."

### Sequence executed
1. **Snapshot before** — record PIDs, last block of each chain, port assignments.
2. **`systemctl --user restart memphis.service`** — graceful shutdown observed:
   ```
   {"msg":"graceful shutdown started (0 in-flight turns; drain budget 15000ms)"}
   {"msg":"pino flush — flushed=17 errors=0"}
   {"msg":"shutdown complete; exiting 0","exitCode":0,"drained":true}
   ```
   New PID 2678753, port 3000 alive within 9 seconds, Telegram gateway started, self-reflection lifecycle loop restarted.
3. **`kill -TERM -KILL` orphaned python servers** that had no systemd unit:
   - PID 7132 → dashboard :8765 (auto-restarted by some monitor as PID 2678908)
   - PID 8913 → lr-dashboard :3001
   - PID 32357 → piper TTS :5500
   - PID 33632 → whisper STT :9000
4. **`systemctl --user stop memphis-grabber-feed.service`** — was in an infinite auto-restart loop because `/dev/video0` does not exist. Backoff loop. Unit file remains at `~/.config/systemd/user/memphis-grabber-feed.service` if you ever want to re-enable with a real video device.
5. **`systemctl --user daemon-reload`** — picked up unit file changes.
6. **`systemctl --user start memphis-{warmup,piper-tts,whisper-stt,lr-dashboard}.service`** — brought them back.

### What survived vs what had to come back

| Layer | Before | After | Δ |
|---|---|---|---|
| memphis.service PID | 8905 (3d uptime) | 2678753 | new |
| Port 3000 (memphis) | listening | listening | alive |
| Port 3001 (lr-dashboard) | 8913 | 2679285 | restarted |
| Port 5500 (piper TTS) | 32357 | 2678998 | restarted |
| Port 8765 (dashboard) | 7132 | 2678908 | restarted |
| Port 9000 (whisper STT) | 33632 | 2679000 | restarted |
| Port 11434 (Ollama) | n/a | n/a | not touched |
| Telegram gateway | ready | ready | survived |
| Vault (11 entries) | integrity_ok | integrity_ok | survived |
| **Soul block 000256 (manual)** | hash `23fa915b...` | hash `23fa915b...` | **survived atomic write** |
| Decisions chain | 221 blocks | 221 blocks | intact |
| Journal chain | 484 blocks | 484 blocks | intact |
| Sessions (DB) | 20 rows | 20 rows | survived |
| Embeddings | 1560 semantic_docs | 1560 | survived (loaded from index-v1.json) |
| Case index SQLite | 20 rows | 20 rows | survived |

### Rule of thumb for next session

**Persistent state survives every kind of restart:**
- Soul / decisions / journal / cases / patterns / reflections / insights / system / collective chains (11 chains total, all on disk as JSON files with `chain-adapter.ts writeBlockAtomic` tmp+rename)
- Vault (encrypted master key + entries, on disk)
- SQLite DB (`memphis.db`, `case-index.sqlite`, `dashboard.db`)
- Embeddings index (`~/.memphis/embed/index-v1.json`, atomic reindex per issue #628 fix)

**In-memory state is wiped and recreated:**
- memphis.service daemon process
- All subprocess servers (TTS, STT, dashboards) unless they have systemd `Restart=on-failure` set
- Active LLM context, in-flight turns (graceful drain observed)

**Always-restart processes to expect:**
- lr-dashboard (`lr-dashboard.service`)
- dashboard :8765 (some monitor — possibly systemd or external, not pinned to a unit)
- piper :5500 (`memphis-piper-tts.service`)
- whisper :9000 (`memphis-whisper-stt.service`)

**Stays dead until manually started:**
- `memphis-grabber-feed.service` — disabled this session (broken auto-restart loop)

### Decision chain reference
`decisions[222]` — full restart report with VERIFIED/UNVERIFIED matrix.

---

## TL;DR for future sessions

1. **Soul chain append is possible manually** but only with explicit operator confirmation, and only via filesystem write of `{chains_dir}/{index:06d}.json` with hand-computed SHA-256 hash using `stableStringify + toCanonicalHashData`. No CLI/MCP tool exists. See Part 1 for the exact algorithm and the verification step.
2. **Restart sequence that works without killing your own session:** `systemctl --user restart memphis.service` (this is the memphis daemon at port 3000, not the TUI). Then kill orphaned Python servers, daemon-reload, restart dependents. The TUI cockpit (`memphis-tui`) is in a separate process tree and is safe.
3. **Everything on disk survives.** `memphis_chain_verify <chain>` after restart confirms all chains are still hash-linked.
4. **In-memory processes always need a restart.** Plan for ~10 seconds of downtime on memphis.service and the dependent services.
5. **`MEMPHIS_SOUL_STRICT` does not exist as a config var** (verified at this session — none in env, none in `state/`). Future soul appends remain feasible without signature.

## Follow-ups for operator consideration

- **Should `memphis chain append soul` be a CLI command?** It would close the gap I had to close manually. Tier-2-adjacent since soul is verified, but it would also remove a foot-gun (a miscomputed hash corrupts the chain).
- **Should the cron job that calls `memphis chain integrity sweep` (currently scheduled) include soul?** Currently only system + security chains are audit-guarded per `chain-adapter.ts AUDIT_GUARDED_CHAINS = new Set(['system','security'])`. Adding soul would catch manual-write errors on the next sweep instead of on next `chain_verify`.
- **Is the `memphis-grabber-feed.service` loop useful?** If `/dev/video0` is permanently unavailable on this host, the unit should be `enable=false` by default. Currently `enabled` per `systemctl --user list-unit-files`.

## Anti-confab

**VERIFIED (live):**
- Block 000256 atomic write survives restart (verified by `memphis_chain_verify soul` → 256 blocks OK; round-trip hash reproduce = `23fa915b...`).
- memphis.service graceful shutdown exit code 0.
- All 11 chains still hash-linked after restart.
- Vault 11 entries integrity_ok pre and post.
- Telegram gateway state "ready" both before and after.

**UNVERIFIED:**
- Rust NAPI backend recomputes the same hash on read for soul (algorithm matches but serialization paths differ — TS uses JSON.stringify of sorted map, Rust uses serde_json of struct in declaration order). For 3-key canonical data the order matches; for any non-canonical write it would diverge. Untested end-to-end.
- The new memphis process (PID 2678753) hasn't yet written a fresh soul block (auto-reflection cycle every ~5min). If it does, that block's hash linkage from 256 must be valid — but it isn't there yet at the time of writing this.

**OUT OF SCOPE:**
- Full OS reboot (would kill the SSH session hosting this TUI).
- Hard kill -9 on memphis.service (would lose unflushed WAL).
- Re-enabling `memphis-grabber-feed.service` (operator action when video device available).
- Hardening #10 from `/tmp/memphis-chain-draft-audit.md` (clippy `-D warnings` on the memphis-chain draft) — separate task.
