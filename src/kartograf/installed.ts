import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, open, readdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { canonicalize, verifyCheckpoint, type CheckpointEnvelope } from './checkpoint.js';
import { createKartografSession } from './session.js';
import { getDataDir } from '../config/paths.js';
import { writePrivateAtomicFile } from '../infra/config/private-atomic-file.js';

export interface InstalledBundle {
  id: string;
  envelopePath: string;
  envelope: CheckpointEnvelope;
  signerSlug: string;
}
const MAX_MODEL_BYTES = 2 * 1024 * 1024 * 1024;
export const checkpointRoot = (env: NodeJS.ProcessEnv) =>
  join(getDataDir(env), 'kartograf', 'checkpoints');
function pathPresent(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
const pointerPath = (env: NodeJS.ProcessEnv) => join(getDataDir(env), 'kartograf', 'active.json');

function regularFile(file: string, limit: number): void {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error('Checkpoint artifact must be a bounded regular file');
}
async function fileHash(file: string, limit: number): Promise<string> {
  regularFile(file, limit);
  const hash = createHash('sha256');
  let size = 0;
  for await (const part of createReadStream(file)) {
    size += part.length;
    if (size > limit) throw new Error('Checkpoint artifact size limit exceeded');
    hash.update(part);
  }
  return hash.digest('hex');
}
export async function inspectInstalledBundle(envelopePath: string): Promise<InstalledBundle> {
  regularFile(envelopePath, 1024 * 1024);
  let envelope: CheckpointEnvelope;
  try {
    envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as CheckpointEnvelope;
  } catch {
    throw new Error('Invalid checkpoint envelope JSON');
  }
  const verified = verifyCheckpoint(envelope);
  if (!verified.valid) throw new Error('Checkpoint envelope signature or schema invalid');
  const directory = dirname(envelopePath);
  for (const [name, expected, limit] of [
    ['model.onnx', envelope.onnx_sha256, MAX_MODEL_BYTES],
    ['tokenizer.json', envelope.tokenizer_sha256, 64 * 1024 * 1024],
  ] as const) {
    if ((await fileHash(join(directory, name), limit)) !== expected)
      throw new Error(`${name}: sha256 mismatch`);
  }
  return {
    id: createHash('sha256').update(canonicalize(envelope)).digest('hex'),
    envelopePath: resolve(envelopePath),
    envelope,
    signerSlug: verified.signerDid.slice(-12),
  };
}
export async function installedBundles(env: NodeJS.ProcessEnv): Promise<InstalledBundle[]> {
  const root = checkpointRoot(env);
  if (!existsSync(root)) return [];
  if (lstatSync(root).isSymbolicLink()) throw new Error('Checkpoint store cannot be a symlink');
  const names = (await readdir(root))
    .filter((name) => /^[a-f0-9]{12}$|^[a-f0-9]{64}$/.test(name))
    .sort();
  if (names.length > 1000) throw new Error('Checkpoint catalog limit exceeded');
  const bundles: InstalledBundle[] = [];
  for (const name of names) {
    try {
      const directory = join(root, name);
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) continue;
      const bundle = await inspectInstalledBundle(join(directory, 'checkpoint.json'));
      if (name.length === 64 && name !== bundle.id) continue;
      bundles.push(bundle);
    } catch {
      /* A corrupt or incomplete bundle never becomes a candidate. */
    }
  }
  return bundles;
}
export async function selectedBundle(env: NodeJS.ProcessEnv): Promise<InstalledBundle | null> {
  const pointer = pointerPath(env);
  const bundles = await installedBundles(env);
  if (pathPresent(pointer)) {
    regularFile(pointer, 16 * 1024);
    let selected: { version?: number; id?: string; signerDid?: string };
    try {
      selected = JSON.parse(readFileSync(pointer, 'utf8'));
    } catch {
      throw new Error('Active checkpoint pointer is invalid');
    }
    const bundle = bundles.find(
      (entry) =>
        selected.version === 1 &&
        entry.id === selected.id &&
        entry.envelope.signer_did === selected.signerDid,
    );
    if (!bundle) throw new Error('Active checkpoint is missing or has failed integrity validation');
    return bundle;
  }
  // Preserve an older explicitly installed model. New immutable installs stay
  // staged until the operator activates one; directory order cannot activate it.
  return (
    bundles.find((entry) =>
      /^[a-f0-9]{12}$/.test(dirname(entry.envelopePath).split(/[\\/]/).at(-1)!),
    ) ?? null
  );
}

/** Publish a complete, verified immutable bundle; never remove a prior install. */
export async function installBundle(
  source: string,
  env: NodeJS.ProcessEnv,
  dryRun = false,
): Promise<InstalledBundle> {
  env = { ...env };
  const inspected = await inspectInstalledBundle(resolve(source));
  const root = checkpointRoot(env);
  const destination = join(root, inspected.id);
  const envelopePath = join(destination, 'checkpoint.json');
  if (pathPresent(destination)) {
    if (lstatSync(destination).isSymbolicLink())
      throw new Error('Checkpoint destination cannot be a symlink');
    const existing = await inspectInstalledBundle(envelopePath);
    if (existing.id !== inspected.id) throw new Error('Checkpoint destination integrity mismatch');
    return existing;
  }
  if (dryRun) return { ...inspected, envelopePath };
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink()) throw new Error('Checkpoint store cannot be a symlink');
  const staging = await mkdtemp(join(root, '.install-'));
  for (const name of ['model.onnx', 'tokenizer.json']) {
    await copyFile(join(dirname(source), name), join(staging, name));
    await chmod(join(staging, name), 0o600);
    const file = await open(join(staging, name), 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
  }
  writePrivateAtomicFile(
    join(staging, 'checkpoint.json'),
    JSON.stringify(inspected.envelope, null, 2),
    { exclusive: true },
  );
  const staged = await inspectInstalledBundle(join(staging, 'checkpoint.json'));
  if (staged.id !== inspected.id) throw new Error('Checkpoint source changed during install');
  // Concurrent same-ID installs contain identical verified bytes. Never replace
  // a nonempty installed directory; retain failed private staging for inspection.
  try {
    await rename(staging, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    const existing = await inspectInstalledBundle(envelopePath);
    if (existing.id !== inspected.id) throw new Error('Concurrent checkpoint install mismatch');
  }
  const directory = await open(root, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return inspectInstalledBundle(envelopePath);
}

/** Explicitly acknowledge producer identity and prove real inference before selection. */
export async function activateBundle(
  id: string,
  trustedSigner: string,
  env: NodeJS.ProcessEnv,
  dryRun = false,
): Promise<InstalledBundle> {
  env = { ...env };
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Activation requires a full checkpoint ID');
  if (!/^did:key:ed25519:[a-f0-9]{64}$/.test(trustedSigner))
    throw new Error('Activation requires --trusted-signer DID');
  const bundle = (await installedBundles(env)).find((candidate) => candidate.id === id);
  if (!bundle) throw new Error('Checkpoint is not completely installed and verified');
  if (bundle.envelope.signer_did !== trustedSigner)
    throw new Error('Checkpoint signer is not trusted');
  if (dryRun) return bundle;
  const session = await createKartografSession(
    { checkpointPath: bundle.envelopePath, headsConfig: bundle.envelope.heads_config },
    { ...env, MEMPHIS_KARTOGRAF_ENABLE: '1' },
  );
  try {
    if (
      session.checkpointId.startsWith('stub:') ||
      session.checkpointId !== bundle.envelope.onnx_sha256
    )
      throw new Error('Checkpoint activation refused: real ONNX session required');
    const probe = await session.embed('Kartograf activation integrity check');
    if (
      probe.checkpointId !== bundle.envelope.onnx_sha256 ||
      !probe.zones.length ||
      !probe.zones.every(
        (zone) => Number.isFinite(zone.score) && zone.score >= 0 && zone.score <= 1,
      ) ||
      probe.embedding.length !== bundle.envelope.heads_config.embedding_dim ||
      !probe.embedding.every(Number.isFinite) ||
      !probe.embedding.some((value) => value !== 0)
    )
      throw new Error('Checkpoint activation refused: invalid inference output');
  } finally {
    await session.close();
  }
  // Revalidate after the potentially long model load before publishing trust.
  const current = await inspectInstalledBundle(bundle.envelopePath);
  if (current.id !== id) throw new Error('Checkpoint changed during activation');
  writePrivateAtomicFile(
    pointerPath(env),
    JSON.stringify({ version: 1, id, signerDid: trustedSigner }, null, 2),
  );
  return bundle;
}
