#!/usr/bin/env node
// Chain integrity sweep — hourly check of last N blocks per chain.
// Reads each block via JSON.parse, logs results, exits non-zero on any failure.
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
// CHAINS_DIR environment variable (added 2026-09-21, ADR-008):
//   - Defaults to /home/memphis/.memphis/chains for the operator's box
//   - Overrides by tests / CI / portable verification passes a tmpdir
//     so the sweep is hermetic. The systemd unit does NOT set the env
//     var, so operator behaviour is unchanged.

import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const CHAINS_DIR = process.env.CHAINS_DIR || '/home/memphis/.memphis/chains';

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const tail = Number(getArg('tail', '5'));
const onlyChain = getArg('chain', null);

async function listBlocks(chainDir, tailN) {
  // Read directory, filter 000*.json, sort numerically by index, take last N.
  // A directory removed between the chain list and this read used to throw
  // ENOENT out of the process (exit 1, no summary) — the one case this
  // sweep exists to notice. Return null so the caller can classify it.
  let all;
  try {
    all = await readdir(chainDir);
  } catch {
    return null;
  }
  return all
    .filter((f) => /^000\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(3, 9)) - Number(b.slice(3, 9)))
    .slice(-tailN);
}

/**
 * Count block-shaped files below `dir`, one level deep — enough for the
 * quarantine layout (`_quarantine/<reason>/NNN.json`).
 *
 * Deliberately uses a WIDER name pattern than `listBlocks` above: the
 * orphan quarantine holds files like `003592.json` (no `000` prefix),
 * which `listBlocks`' `^000\d+\.json$` rejects. Counting only the narrow
 * shape would report a 403-block quarantine as empty and raise a false
 * data-loss alarm every hour. Broadened here only; the checked path is
 * unchanged so the CI contract stays intact.
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

async function checkBlock(chain, file) {
  const p = join(chain, file);
  try {
    const raw = await readFile(p, 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.index !== 'number' || typeof obj.hash !== 'string') {
      return { ok: false, file, error: 'missing required fields' };
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

  // Test seam for the vanished-directory race. Off unless the env var is
  // set, so production runs are untouched: the child removes a directory
  // after the chain list exists but before its blocks are read.
  if (process.env.SWEEP_DELETE_AFTER_LIST) {
    await rm(process.env.SWEEP_DELETE_AFTER_LIST, { recursive: true, force: true });
  }

  const results = [];
  let failures = 0;

  const emptyChains = [];
  const vanishedChains = [];
  // Chains whose blocks live in subdirectories (quarantine containers).
  // Healthy — reported for visibility, never counted as a failure.
  const nestedOnly = [];

  for (const chain of chains) {
    const chainDir = join(CHAINS_DIR, chain);
    const blocks = await listBlocks(chainDir, tail);

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

    const checked = await Promise.all(blocks.map((f) => checkBlock(chainDir, f)));
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
    ok: failures === 0 && shapeFailures === 0,
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
  if (failures > 0) process.exit(1);
  if (shapeFailures > 0) process.exit(3);
  process.exit(0);
}

main();
