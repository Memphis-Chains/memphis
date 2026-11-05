#!/usr/bin/env node
// Chain sweep — check every stored link and the last N block shapes per chain.
// Links compare the stored prev_hash and hash; this does not recompute block
// hashes. The summary states that limitation explicitly.
// Defensive: never modifies any block. Read-only.
//
// Usage:
//   node scripts/chain-integrity-sweep.mjs                                       # check all chains, last 5 blocks each
//   CHAINS_DIR=/tmp/foo node scripts/chain-integrity-sweep.mjs                   # sweep an alternate chains dir (CI / tests)
//   node scripts/chain-integrity-sweep.mjs --tail 50                             # check last 50 blocks each
//   node scripts/chain-integrity-sweep.mjs --chain cases --tail 20                # one chain only
//
// SWEEP_DELETE_AFTER_LIST (tests only): removes that path right after the
//   chain list is read, to exercise the vanished-directory branch.
//
// Exit codes:
//   0 — all blocks parse OK
//   1 — at least one block failed to parse (with details on stderr)
//   2 — scan error (e.g. missing chains dir)
//   3 — chain-shape anomaly: a chain directory holds no blocks, or a
//       directory vanished mid-sweep. Previously these were indistinguishable
//       from a healthy run — `chains_scanned` counts directories, so a
//       vanished chain silently lowers the count while `ok` stays true.
//       Seen 2026-10-07 19:00: chains_scanned dropped 14 -> 3 with
//       ok:true and blocks_ok:7, which reads as a health line in a log.
//
// THE ORACLE (S1, 2026-11-04)
//
// The sweep used to be the weakest of the three oracles in this
// repository: it accepted a block if the file parsed as JSON and carried
// `index` and `hash`. It never asked the native core, so it reported
// `ok: true` over blocks the core cannot deserialize at all — measured
// on this host, side by side: the sweep said ok, the audit named two
// unreadable blocks.
//
// The sweep now asks the core, when the core is loadable, and says so in
// its summary (`oracle: "native-core"` or `oracle: "structural"`). The
// structural check stays as the fallback so the hourly timer on a host
// without a built bridge still runs — but the summary then says which
// oracle answered, so a green line cannot be mistaken for the stronger
// one.
//
// CHAINS_DIR environment variable (added 2026-09-21, ADR-008):
//   - Defaults to /home/memphis/.memphis/chains for the operator's box
//   - Overrides by tests / CI / portable verification passes a tmpdir
//     so the sweep is hermetic. The systemd unit does NOT set the env
//     var, so operator behaviour is unchanged.

import { readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHAINS_DIR = process.env.CHAINS_DIR || '/home/memphis/.memphis/chains';

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const tail = Number(getArg('tail', '5'));
const onlyChain = getArg('chain', null);

/**
 * Load the native core, if it is built.
 *
 * The bridge is a Node addon (`crates/memphis-napi/index.node`). The
 * script is plain JavaScript on purpose — it runs from the repository
 * on the operator's host, with no build step of its own — so it loads
 * the addon directly instead of importing the TypeScript adapter.
 */
function loadNativeCore() {
  const require = createRequire(import.meta.url);
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  const override = process.env.RUST_CHAIN_BRIDGE_PATH?.trim();
  if (override) candidates.push(override);
  candidates.push(resolve(here, '..', 'crates', 'memphis-napi'));
  candidates.push(resolve(process.cwd(), 'crates', 'memphis-napi'));

  for (const candidate of candidates) {
    try {
      const bridge = require(candidate);
      if (typeof bridge?.chain_validate === 'function') return bridge;
    } catch {
      // Not built here, or not loadable — try the next candidate.
    }
  }
  return null;
}

/**
 * Ask the core ONE question: can it DESERIALIZE this block?
 *
 * Returns the core's complaint, or null when the core could read it.
 * The bridge answers with a JSON STRING (`{"ok":true,"data":{"valid":
 * true},"error":null}`) — the same envelope the TypeScript adapter
 * parses — so it is parsed here before it is read.
 *
 * WHY ONLY THAT QUESTION
 *
 * A non-ok envelope is the core refusing the block's SHAPE: an unknown
 * type, a missing field. That is the vocabulary question — the one the
 * sweep was blind to, and the one the plan names (H1).
 *
 * The envelope's `valid` flag is a different question: whether the
 * block's hash and its link are right. It is deliberately NOT a fatal
 * criterion here, and the reason is measured, not stylistic: the core
 * canonicalizes a read-side ALIAS type (`security_event` ->
 * `system_event`) before hashing, while the writer that produced the
 * legacy blocks hashed the raw type. So on this host the core reports
 * "hash mismatch" for 47 blocks whose chain is internally consistent —
 * the TypeScript verifier checks all of them and passes. Failing the
 * hourly gate on those would be crying wolf; the hash is
 * `verifyChainIntegrity`'s question, and the disagreement itself is
 * written up in the plan (S1) as a finding that needs an operator
 * decision.
 */
function coreComplaint(core, block) {
  let envelope;
  try {
    const raw = core.chain_validate(JSON.stringify(block), undefined);
    envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    return `chain_validate failed: ${error?.message ?? String(error)}`;
  }
  if (!envelope || envelope.ok !== true) {
    return envelope?.error ?? 'the core refused the block';
  }
  return null;
}

async function listBlocks(chainDir) {
  // Read all numeric block files in index order; caller selects the tail.
  // A directory removed between the chain list and this read used to throw
  // ENOENT out of the process (exit 1, no summary) — the one case this
  // sweep exists to notice. Return null so the caller can classify it.
  //
  let all;
  try {
    all = await readdir(chainDir);
  } catch {
    return null;
  }
  return all
    .filter((f) => /^\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)));
}

/** Check stored linkage over the whole chain, including old blocks. */
async function checkStoredLinks(chainDir, files) {
  let previous;
  let checked = 0;
  for (const file of files) {
    let block;
    try {
      block = JSON.parse(await readFile(join(chainDir, file), 'utf8'));
    } catch {
      return { ok: false, file, error: 'unreadable block while checking links', checked };
    }
    if (
      !Number.isSafeInteger(block.index) ||
      block.index < 0 ||
      typeof block.hash !== 'string' ||
      typeof block.prev_hash !== 'string' ||
      Number(file.slice(0, -5)) !== block.index
    ) {
      return {
        ok: false,
        file,
        error: 'invalid block index, filename or stored hash fields',
        checked,
      };
    }
    if (previous && (block.index !== previous.index + 1 || block.prev_hash !== previous.hash)) {
      return { ok: false, file, error: 'stored block linkage mismatch', checked };
    }
    previous = block;
    checked += 1;
  }
  return { ok: true, checked };
}

/**
 * Count block-shaped files below `dir`, one level deep — enough for the
 * quarantine layout (`_quarantine/<reason>/NNN.json`).
 *
 * Deliberately uses a WIDER name pattern than `listBlocks` above: the
 * orphan quarantine holds numeric block files in nested directories,
 * not at the top level. Count them without treating the container as empty.
 */
async function countNestedBlocks(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = await readdir(join(dir, entry.name));
    total += nested.filter((f) => /^\d+\.json$/.test(f) || /^000\d+\.json$/.test(f)).length;
  }
  return total;
}

async function checkBlock(chain, file, core) {
  const p = join(chain, file);
  try {
    const raw = await readFile(p, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.index !== 'number' || typeof obj.hash !== 'string') {
      return { ok: false, file, error: 'missing required fields' };
    }
    if (core) {
      const complaint = coreComplaint(core, obj);
      if (complaint) {
        return { ok: false, file, error: complaint };
      }
    }
    return { ok: true, file, index: obj.index, hash: obj.hash.slice(0, 16), ts: obj.timestamp };
  } catch (e) {
    return { ok: false, file, error: e.message };
  }
}

async function main() {
  let chains;
  try {
    const entries = await readdir(CHAINS_DIR, { withFileTypes: true });
    chains = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, stage: 'list_chains', err: e.message }));
    process.exit(2);
  }
  if (onlyChain) chains = chains.filter((c) => c === onlyChain);

  const core = loadNativeCore();
  const oracle = core ? 'native-core' : 'structural';

  // Test seam for the vanished-directory race. Off unless the env var is
  // set, so production runs are untouched: the child removes a directory
  // after the chain list exists but before its blocks are read.
  if (process.env.SWEEP_DELETE_AFTER_LIST) {
    await rm(process.env.SWEEP_DELETE_AFTER_LIST, { recursive: true, force: true });
  }

  const results = [];
  let failures = 0;
  let linkFailures = 0;
  let linkBlocksChecked = 0;

  const emptyChains = [];
  const vanishedChains = [];
  // Chains whose blocks live in subdirectories (quarantine containers).
  // Healthy — reported for visibility, never counted as a failure.
  const nestedOnly = [];

  for (const chain of chains) {
    const chainDir = join(CHAINS_DIR, chain);
    const blocks = await listBlocks(chainDir);

    if (blocks === null) {
      vanishedChains.push(chain);
      continue;
    }

    // A directory that held blocks and now lists none is a data-loss
    // signal, not an empty category. Containers hold blocks one level
    // down (`_quarantine/<reason>/NNN.json`), so a top-level readdir sees
    // zero files there — recurse before calling a chain empty, otherwise
    // the check fires every hour on a healthy quarantine dir.
    if (blocks.length === 0) {
      let exists = true;
      let nested = 0;
      try {
        nested = await countNestedBlocks(chainDir);
      } catch {
        exists = false;
      }
      if (exists && nested === 0) emptyChains.push(chain);
      else if (!exists) vanishedChains.push(chain);
      else nestedOnly.push(chain);
      continue;
    }

    const linkCheck = await checkStoredLinks(chainDir, blocks);
    linkBlocksChecked += linkCheck.checked;
    if (!linkCheck.ok) {
      linkFailures += 1;
      console.error(
        JSON.stringify({ ok: false, chain, file: linkCheck.file, err: linkCheck.error }),
      );
    }

    const checkedFiles = blocks.slice(-tail);
    const checked = await Promise.all(checkedFiles.map((f) => checkBlock(chainDir, f, core)));
    for (const r of checked) {
      if (!r.ok) {
        failures += 1;
        console.error(
          JSON.stringify({
            ok: false,
            chain,
            file: r.file,
            err: r.error,
          }),
        );
      } else {
        results.push({
          chain,
          index: r.index,
          file: r.file,
          hash: r.hash,
          ts: r.ts,
        });
      }
    }
  }

  const shapeFailures = emptyChains.length + vanishedChains.length;

  const summary = {
    ok: failures === 0 && shapeFailures === 0 && linkFailures === 0,
    oracle,
    hashes_verified: false,
    link_blocks_checked: linkBlocksChecked,
    link_failures: linkFailures,
    chains_scanned: chains.length,
    chains_with_blocks: new Set(results.map((r) => r.chain)).size,
    chains_empty: emptyChains,
    chains_vanished: vanishedChains,
    chains_nested_only: nestedOnly,
    blocks_checked: results.length + failures,
    blocks_ok: results.length,
    blocks_failed: failures,
    tail_per_chain: tail,
    timestamp: new Date().toISOString(),
  };
  if (shapeFailures > 0) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          stage: 'chain_shape',
          err: `chain directories without readable blocks: ${emptyChains.length} empty, ${vanishedChains.length} vanished`,
          empty: emptyChains,
          vanished: vanishedChains,
        },
        null,
        2,
      ),
    );
  }
  console.log(JSON.stringify(summary, null, 2));
  if (failures > 0 || linkFailures > 0) process.exit(1);
  if (shapeFailures > 0) process.exit(3);
  process.exit(0);
}

main();
