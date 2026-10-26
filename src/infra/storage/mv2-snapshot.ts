import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { chmod, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { exportChain, validateChainSnapshot, type ChainBlock } from './chain-adapter.js';
import { writeBlockAtomic } from './chain-file-io.js';
import { withChainWriteLock } from './chain-write-lock.js';
import { loadPlatformAwareBridge } from './napi-contract.js';
import { getChainPath, getDataDir } from '../../config/paths.js';
import { canonicalize } from '../../kartograf/checkpoint.js';
import { CHAIN_CATALOG } from '../../memory/chain-catalog.js';
import { withVaultSecret } from '../../security/vault-boundary.js';
import { writePrivateAtomicFile } from '../config/private-atomic-file.js';
import { assertAuditWriteAllowed } from '../logging/audit-write-guard.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

const MAX_BYTES = 128 * 1024 * 1024;
const MANIFEST_ID = 'memphis.mv2.snapshot.v1';
const DID_PREFIX = 'did:key:ed25519:';
const DOMAIN = 'memphis.mv2.snapshot.v1\n';
type Frame = { track: 'journal' | 'chains'; id: string; payload: unknown };
export interface Mv2Manifest {
  kind: 'memphis-mv2-snapshot';
  version: 1;
  blockEncoding: 'json-string-v1';
  createdAt: string;
  chains: string[];
  counts: Record<string, number>;
  recordsSha256: string;
  signerDid: string;
  signature: string;
}
export interface Mv2Snapshot {
  manifest: Mv2Manifest;
  blocks: Map<string, ChainBlock[]>;
  blockCount: number;
}

function knownChain(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(CHAIN_CATALOG, value);
}
export function selectMv2Chains(include?: string): string[] {
  const chosen = new Set<string>();
  for (const value of (include || 'journal,chains')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (value === 'chains')
      Object.keys(CHAIN_CATALOG)
        .filter((name) => name !== 'journal')
        .forEach((name) => chosen.add(name));
    else if (knownChain(value)) chosen.add(value);
    else throw new Error(`Unknown --include track: "${value}". Use catalog chain names or chains.`);
  }
  if (!chosen.size) throw new Error('MV2 requires at least one chain');
  return [...chosen].sort();
}
function bridge(rawEnv: NodeJS.ProcessEnv) {
  const loaded = loadPlatformAwareBridge(resolveRustBridgePath(rawEnv));
  const encode = loaded?.mv2_export ?? loaded?.mv2Export;
  const inspect = loaded?.mv2_inspect ?? loaded?.mv2Inspect;
  if (typeof encode !== 'function' || typeof inspect !== 'function')
    throw new Error('MV2 native bridge unavailable');
  return {
    encode: encode as (records: string, tracks: string) => string,
    inspect: inspect as (hex: string) => string,
  };
}
function envelope<T>(raw: string): T {
  try {
    const value = JSON.parse(raw);
    if (!value.ok || value.data === undefined) throw new Error();
    return value.data as T;
  } catch {
    throw new Error('MV2 native codec refused the container');
  }
}
function checkJson(value: unknown, depth = 0): void {
  if (depth > 64) throw new Error('MV2 payload nesting limit exceeded');
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error('MV2 cannot preserve an unsafe JSON number');
  if (value && typeof value === 'object')
    for (const child of Object.values(value)) checkJson(child, depth + 1);
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
function signingBytes(manifest: Omit<Mv2Manifest, 'signature'>): Buffer {
  return Buffer.from(DOMAIN + canonicalize(manifest));
}
function frameId(block: ChainBlock): string {
  return `${block.chain}:${block.index}:${block.hash}`;
}

/** Per-chain snapshots are read under the same lock used by TS/native writers. */
export async function exportMv2Snapshot(
  output: string,
  include: string | undefined,
  rawEnv: NodeJS.ProcessEnv,
): Promise<{ manifest: Mv2Manifest; blockCount: number; bytes: number }> {
  const names = selectMv2Chains(include);
  const frames: Frame[] = [];
  const counts: Record<string, number> = {};
  let sourceBytes = 0;
  const chainRoot = getChainPath(undefined, rawEnv);
  for (const name of names) {
    counts[name] = 0;
    if (!existsSync(chainRoot)) continue;
    const directory = join(realpathSync(chainRoot), name);
    if (!existsSync(directory)) {
      try {
        lstatSync(directory);
        throw new Error('MV2 refuses a dangling chain symlink');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      continue;
    }
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())
      throw new Error('MV2 refuses chain symlinks or non-directories');
    const blocks = await withChainWriteLock(directory, async () => {
      for (const file of await readdir(directory)) {
        if (!file.endsWith('.json')) continue;
        const info = lstatSync(join(directory, file));
        if (!/^\d{6,}\.json$/.test(file) || info.isSymbolicLink() || !info.isFile())
          throw new Error('MV2 source contains an unexpected block file');
        sourceBytes += info.size;
        if (sourceBytes > MAX_BYTES) throw new Error('MV2 snapshot exceeds the 128 MiB limit');
      }
      return (await exportChain(name, { ...rawEnv, MEMPHIS_CHAIN_REPAIR_ON_MISMATCH: 'false' }))
        .blocks;
    });
    validateChainSnapshot(name, blocks);
    counts[name] = blocks.length;
    for (const block of blocks) {
      checkJson(block);
      frames.push({
        track: name === 'journal' ? 'journal' : 'chains',
        id: frameId(block),
        // Keep numbers opaque to serde_json's float parser; Node owns block JSON.
        payload: JSON.stringify(block),
      });
    }
  }
  const unsigned = {
    kind: 'memphis-mv2-snapshot' as const,
    version: 1 as const,
    blockEncoding: 'json-string-v1' as const,
    createdAt: new Date().toISOString(),
    chains: names,
    counts,
    recordsSha256: digest(frames),
  };
  let manifest: Mv2Manifest;
  try {
    manifest = withVaultSecret(
      'did_seed',
      { surface: 'cli', command: 'export mv2' },
      (value) => {
        if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error();
        const seed = Buffer.from(value, 'hex');
        try {
          const privateKey = createPrivateKey({
            key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
            format: 'der',
            type: 'pkcs8',
          });
          const pub = createPublicKey(privateKey)
            .export({ format: 'der', type: 'spki' })
            .subarray(-32)
            .toString('hex');
          const payload = { ...unsigned, signerDid: DID_PREFIX + pub };
          return {
            ...payload,
            signature: sign(null, signingBytes(payload), privateKey).toString('hex'),
          };
        } finally {
          seed.fill(0);
        }
      },
      rawEnv,
    );
  } catch {
    throw new Error(
      'MV2 signing identity unavailable; configure or recover the existing DID first',
    );
  }
  const blockCount = frames.length;
  frames.push({ track: 'chains', id: MANIFEST_ID, payload: manifest });
  const serialized = JSON.stringify(frames);
  if (Buffer.byteLength(serialized) > MAX_BYTES)
    throw new Error('MV2 snapshot exceeds the 128 MiB limit');
  const out = envelope<{ bytes_hex: string; frame_count: number }>(
    bridge(rawEnv).encode(serialized, '["journal","chains"]'),
  );
  if (!/^(?:[a-f0-9]{2})+$/i.test(out.bytes_hex) || out.frame_count !== frames.length)
    throw new Error('Invalid MV2 codec result');
  const bytes = Buffer.from(out.bytes_hex, 'hex');
  if (bytes.length > MAX_BYTES) throw new Error('MV2 snapshot exceeds the 128 MiB limit');
  writePrivateAtomicFile(resolve(output), bytes, { exclusive: true });
  return { manifest, blockCount, bytes: bytes.length };
}

function localSigner(rawEnv: NodeJS.ProcessEnv): string | undefined {
  try {
    const value = JSON.parse(readFileSync(join(getDataDir(rawEnv), 'did.json'), 'utf8'));
    return typeof value.did === 'string' ? value.did : undefined;
  } catch {
    return undefined;
  }
}
/** All bytes, signatures, identities and blocks are checked before any destination writes. */
export async function inspectMv2Snapshot(
  file: string,
  rawEnv: NodeJS.ProcessEnv,
  trustedSigner?: string,
): Promise<Mv2Snapshot> {
  if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile())
    throw new Error('MV2 input must be a regular file');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BYTES) throw new Error('MV2 container exceeds the 128 MiB limit');
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (
    bytes.length < 44 ||
    !bytes.subarray(0, 4).equals(Buffer.from('MV2\0')) ||
    bytes.readUInt32LE(4) !== 0
  )
    throw new Error('Unsupported MV2 container');
  const count = bytes.readUInt32LE(40);
  if (count > 1_000_000 || count > Math.floor((bytes.length - 44) / 9))
    throw new Error('Invalid MV2 frame count');
  const metadata = envelope<{ count: number }>(bridge(rawEnv).inspect(bytes.toString('hex')));
  if (metadata.count !== count) throw new Error('MV2 frame count mismatch');
  const frames: Frame[] = [];
  let cursor = 44;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (let i = 0; i < count; i++) {
      const track = bytes[cursor++];
      if (track !== 0 && track !== 1) throw new Error();
      const idLength = bytes.readUInt32LE(cursor);
      cursor += 4;
      const id = decoder.decode(bytes.subarray(cursor, cursor + idLength));
      cursor += idLength;
      const payloadLength = bytes.readUInt32LE(cursor);
      cursor += 4;
      const payload = JSON.parse(decoder.decode(bytes.subarray(cursor, cursor + payloadLength)));
      cursor += payloadLength;
      checkJson(payload);
      frames.push({ track: track === 0 ? 'journal' : 'chains', id, payload });
    }
  } catch {
    throw new Error('Malformed or unsupported MV2 frame');
  }
  if (cursor !== bytes.length) throw new Error('MV2 trailing data');
  const last = frames.pop();
  if (
    last?.id !== MANIFEST_ID ||
    last.track !== 'chains' ||
    frames.some((frame) => frame.id === MANIFEST_ID)
  )
    throw new Error('Signed MV2 snapshot manifest required');
  const manifest = last.payload as Mv2Manifest;
  if (
    !manifest ||
    manifest.kind !== 'memphis-mv2-snapshot' ||
    manifest.version !== 1 ||
    manifest.blockEncoding !== 'json-string-v1' ||
    !Array.isArray(manifest.chains) ||
    !manifest.chains.length ||
    manifest.chains.some((name) => !knownChain(name)) ||
    new Set(manifest.chains).size !== manifest.chains.length ||
    !/^[a-f0-9]{64}$/.test(manifest.recordsSha256 ?? '') ||
    !/^did:key:ed25519:[a-f0-9]{64}$/.test(manifest.signerDid ?? '') ||
    !/^[a-f0-9]{128}$/.test(manifest.signature ?? '') ||
    !Number.isFinite(Date.parse(manifest.createdAt))
  )
    throw new Error('Invalid MV2 manifest');
  const expected = trustedSigner ?? localSigner(rawEnv);
  if (!expected || manifest.signerDid !== expected)
    throw new Error('MV2 signer is not trusted; supply the expected --trusted-signer DID');
  const { signature, ...unsigned } = manifest;
  const key = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(manifest.signerDid.slice(DID_PREFIX.length), 'hex'),
    ]),
    format: 'der',
    type: 'spki',
  });
  if (
    !verify(null, signingBytes(unsigned), key, Buffer.from(signature, 'hex')) ||
    digest(frames) !== manifest.recordsSha256
  )
    throw new Error('MV2 snapshot signature or content digest mismatch');
  const blocks = new Map<string, ChainBlock[]>(manifest.chains.map((name) => [name, []]));
  for (const frame of frames) {
    if (typeof frame.payload !== 'string') throw new Error('Unsupported MV2 block encoding');
    let block: ChainBlock;
    try {
      block = JSON.parse(frame.payload) as ChainBlock;
      checkJson(block);
    } catch {
      throw new Error('Malformed MV2 block JSON');
    }
    if (
      !block ||
      !blocks.has(block.chain) ||
      frame.track !== (block.chain === 'journal' ? 'journal' : 'chains') ||
      frame.id !== frameId(block)
    )
      throw new Error('MV2 frame identity mismatch');
    blocks.get(block.chain)!.push(block);
  }
  if (
    !manifest.counts ||
    Object.keys(manifest.counts).sort().join(',') !== [...manifest.chains].sort().join(',')
  )
    throw new Error('MV2 chain count metadata mismatch');
  for (const [name, records] of blocks) {
    if (manifest.counts[name] !== records.length) throw new Error('MV2 chain count mismatch');
    validateChainSnapshot(name, records);
  }
  return { manifest, blocks, blockCount: frames.length };
}

function restorePlan(snapshot: Mv2Snapshot, into: string, rawEnv: NodeJS.ProcessEnv) {
  const parent = realpathSync(dirname(resolve(into)));
  const target = join(parent, basename(resolve(into)));
  const live = existsSync(getDataDir(rawEnv)) ? realpathSync(getDataDir(rawEnv)) : undefined;
  if (live && (target === live || target.startsWith(live + sep) || live.startsWith(target + sep)))
    throw new Error('MV2 refuses a destination related to the active runtime');
  const absent = () => {
    try {
      lstatSync(target);
      throw new Error('MV2 destination already exists');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  absent();
  if (snapshot.blocks.has('soul'))
    throw new Error('Soul restoration requires the dedicated privileged workflow');
  for (const name of snapshot.blocks.keys())
    if (name === 'system' || name === 'security')
      assertAuditWriteAllowed('mv2.restore:' + name, rawEnv);
  return { parent, target, absent };
}

export async function previewMv2Restore(
  file: string,
  into: string,
  rawEnv: NodeJS.ProcessEnv,
  trustedSigner?: string,
) {
  const snapshot = await inspectMv2Snapshot(file, rawEnv, trustedSigner);
  const { target } = restorePlan(snapshot, into, rawEnv);
  return { target, manifest: snapshot.manifest, blockCount: snapshot.blockCount };
}

/** Restore validated chain blocks through canonical storage I/O into a fresh root. */
async function restoreValidatedSnapshot(
  snapshot: Mv2Snapshot,
  into: string,
  rawEnv: NodeJS.ProcessEnv,
): Promise<string> {
  const { parent, target, absent } = restorePlan(snapshot, into, rawEnv);
  const lockPath = target + '.mv2-import.lock';
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    absent();
    const staging = mkdtempSync(join(parent, '.memphis-mv2-import-'));
    const stagedEnv = { ...rawEnv, MEMPHIS_DATA_DIR: staging, MEMPHIS_HOME: staging };
    for (const [name, records] of snapshot.blocks) {
      const directory = join(staging, 'chains', name);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      for (const block of records) {
        const path = await writeBlockAtomic(directory, block.index, JSON.stringify(block, null, 2));
        await chmod(path, 0o600);
      }
      const written = (await exportChain(name, stagedEnv)).blocks;
      if (canonicalize(written) !== canonicalize(records))
        throw new Error('MV2 restored data differs from the snapshot');
    }
    const chainsDirectory = await open(join(staging, 'chains'), 'r');
    try {
      await chainsDirectory.sync();
    } finally {
      await chainsDirectory.close();
    }
    writePrivateAtomicFile(
      join(staging, 'mv2-import.json'),
      JSON.stringify(snapshot.manifest, null, 2),
      { exclusive: true },
    );
    absent();
    await rename(staging, target);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return target;
  } finally {
    await lock.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function restoreMv2Snapshot(
  file: string,
  into: string,
  rawEnv: NodeJS.ProcessEnv,
  trustedSigner?: string,
) {
  const snapshot = await inspectMv2Snapshot(file, rawEnv, trustedSigner);
  const target = await restoreValidatedSnapshot(snapshot, into, rawEnv);
  return { target, manifest: snapshot.manifest, blockCount: snapshot.blockCount };
}
