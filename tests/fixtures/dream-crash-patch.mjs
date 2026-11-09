import fs from 'node:fs';
import promises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
const link = promises.link;
fs.renameSync = function(source, target) {
  const point = process.env.MEMPHIS_SYNTHETIC_CRASH_POINT;
  if ((point === 'before' || point === 'after') && String(source).includes('soul-memory.json.tmp-') && String(target).endsWith('/soul-memory.json')) {
    if (point === 'after') rename.call(fs, source, target);
    fs.writeSync(1, 'SYNTHETIC_RENAME_HIT\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    if (point === 'before') rename.call(fs, source, target);
    return;
  }
  return rename.call(fs, source, target);
};
promises.link = async function(source, target) {
  const point = process.env.MEMPHIS_SYNTHETIC_CRASH_POINT;
  if ((point === 'before-chain' || point === 'after-chain') && String(target).endsWith('/chains/proposals/000003.json')) {
    if (point === 'after-chain') await link(source, target);
    fs.writeSync(1, 'SYNTHETIC_RENAME_HIT\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    if (point === 'before-chain') await link(source, target);
    return;
  }
  return link(source, target);
};
syncBuiltinESMExports();
