#!/usr/bin/env node
// Chain integrity sweep — hourly check of last N blocks per chain.
// Reads each block via JSON.parse, logs results, exits non-zero on any failure.
// Defensive: never modifies any block. Read-only.
//
// Usage:
//   node scripts/chain-integrity-sweep.mjs           # check all chains, last 5 blocks each
//   node scripts/chain-integrity-sweep.mjs --tail 50 # check last 50 blocks each
//   node scripts/chain-integrity-sweep.mjs --chain cases --tail 20  # one chain only
//
// Exit codes:
//   0 — all blocks parse OK
//   1 — at least one block failed to parse (with details on stderr)
//   2 — scan error (e.g. missing chains dir)

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CHAINS_DIR = '/home/memphis/.memphis/chains';

function getArg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const tail = Number(getArg('tail', '5'));
const onlyChain = getArg('chain', null);

async function listBlocks(chainDir, tailN) {
  // Read directory, filter 000*.json, sort numerically by index, take last N
  const all = (await readdir(chainDir))
    .filter((f) => /^000\d+\.json$/.test(f))
    .sort((a, b) => Number(a.slice(3, 9)) - Number(b.slice(3, 9)));
  return all.slice(-tailN);
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

  const results = [];
  let failures = 0;

  for (const chain of chains) {
    const chainDir = join(CHAINS_DIR, chain);
    const blocks = await listBlocks(chainDir, tail);
    const checked = await Promise.all(blocks.map((f) => checkBlock(chainDir, f)));
    for (const r of checked) {
      if (!r.ok) {
        failures += 1;
        console.error(JSON.stringify({
          ok: false,
          chain,
          file: r.file,
          err: r.error,
        }));
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

  const summary = {
    ok: failures === 0,
    chains_scanned: chains.length,
    blocks_checked: results.length + failures,
    blocks_ok: results.length,
    blocks_failed: failures,
    tail_per_chain: tail,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(failures > 0 ? 1 : 0);
}

main();
