/** Operator-signed approvals for a narrow, additive soul-memory proposal.
 * The local OS account is still the trust boundary: an unrestricted process
 * with its permissions can replace this database or its public key. */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  generateKeyPairSync, randomBytes, scryptSync, sign, verify } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { z } from 'zod';

import { assertValidProposal, type Proposal } from './proposal-lifecycle.js';
import { getDataDir } from '../../config/paths.js';
import { validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { usesOperatorForTier2, validateTier2Passphrase } from '../../infra/auth/tier2-auth.js';
import { canonicalize } from '../../kartograf/checkpoint.js';
import { scanContent } from '../../security/content-scan.js';
import { loadSoulManifest } from '../../soul/manifest.js';
import type { SoulMemoryUpdate } from '../../soul/types.js';

const list = z.array(z.string().min(1).max(4000).refine((item) => item.trim().length > 0)).max(100);
const reflectionPatch = z.object({
  self: z.object({ learnings: list.optional(), evolvedCapabilities: list.optional() }).strict().optional(),
  context: z.object({ recentDecisions: list.optional() }).strict().optional(),
}).strict();

export function validateReflectionProposal(proposal: Proposal): SoulMemoryUpdate {
  assertValidProposal(proposal);
  if (proposal.kind !== 'memory.update' || proposal.target.scope !== 'soul-memory' ||
      proposal.proposer !== 'agent' || !proposal.id.startsWith('reflection:') ||
      !proposal.basedOn.chainBlockHashes.length ||
      !proposal.basedOn.chainBlockHashes.every((hash) => /^[a-f0-9]{64}$/i.test(hash))) {
    throw new Error('only evidence-referencing reflection updates to soul memory are supported');
  }
  const parsed = reflectionPatch.parse(proposal.patch);
  if (![parsed.self?.learnings, parsed.self?.evolvedCapabilities, parsed.context?.recentDecisions]
    .some((items) => items && items.length > 0)) throw new Error('reflection proposal has no changes');
  if (!scanContent(JSON.stringify(parsed), 'memory').allowed) throw new Error('reflection proposal failed memory content scan');
  return parsed;
}

/** Bind the decision to the original material, independent of lifecycle timestamps. */
export function proposalApprovalDigest(proposal: Proposal): string {
  const material: Partial<Proposal> = { ...proposal };
  delete material.status;
  delete material.decidedAt;
  delete material.appliedAt;
  return createHash('sha256').update(canonicalize(material)).digest('hex');
}

export function dreamApprovalDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(env), 'state', 'dream-approvals.sqlite');
}

export function openDreamApprovalDatabase(env: NodeJS.ProcessEnv = process.env): Database.Database {
  const path = dreamApprovalDatabasePath(env);
  mkdirSync(join(getDataDir(env), 'state'), { recursive: true, mode: 0o700 });
  try { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error('dream approval database must be a private regular file (0600)');
  const db = new Database(path, { fileMustExist: true, timeout: 5000 });
  db.exec(`CREATE TABLE IF NOT EXISTS dream_approval_key (
    id INTEGER PRIMARY KEY CHECK(id=1), public_key TEXT NOT NULL, salt TEXT NOT NULL,
    iv TEXT NOT NULL, tag TEXT NOT NULL, encrypted_private_key TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dream_operator_approvals (
    proposal_id TEXT PRIMARY KEY, proposal_digest TEXT NOT NULL, signature TEXT NOT NULL,
    approved_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS dream_approval_key_audit (
    action TEXT NOT NULL, public_key_fingerprint TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  return db;
}

/** Must be called only with a freshly entered local operator secret. */
export function validateDreamOperator(operatorPassphrase: string, tier2Passphrase: string): void {
  if (!operatorPassphrase || !validateOperatorPassphrase(operatorPassphrase)) throw new Error('operator authentication failed');
  const manifest = loadSoulManifest();
  if (!manifest) throw new Error('valid soul manifest is required for Tier 2');
  if (manifest.evolution.requirePassphraseForTier2 || usesOperatorForTier2(manifest)) {
    const result = validateTier2Passphrase(tier2Passphrase, manifest);
    if (result === 'missing') throw new Error('Tier 2 passphrase is not configured');
    if (result !== 'ok') throw new Error('Tier 2 authentication failed');
  }
}

type KeyRow = { public_key: string; salt: string; iv: string; tag: string; encrypted_private_key: string };
const SIGNING_DOMAIN = 'memphis:dream:approval:v1:';
const KEY_DERIVATION = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
function message(digest: string): Buffer { return Buffer.from(SIGNING_DOMAIN + digest, 'utf8'); }

function encryptPrivateKey(privateDer: Buffer, password: string, publicKey: string): KeyRow {
  const salt = randomBytes(16); const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, KEY_DERIVATION);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(privateDer), cipher.final()]);
    return { public_key: publicKey, salt: salt.toString('hex'), iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), encrypted_private_key: encrypted.toString('hex') };
  } finally { key.fill(0); }
}

function signingKey(db: Database.Database, password: string): { privateKey: ReturnType<typeof createPrivateKey>; publicKey: string } {
  let row = db.prepare('SELECT public_key,salt,iv,tag,encrypted_private_key FROM dream_approval_key WHERE id=1').get() as KeyRow | undefined;
  if (!row) {
    const pair = generateKeyPairSync('ed25519');
    const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
    const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
    try {
      row = encryptPrivateKey(privateDer, password, publicKey);
      db.prepare('INSERT INTO dream_approval_key VALUES (1,?,?,?,?,?)').run(row.public_key, row.salt, row.iv, row.tag, row.encrypted_private_key);
    } finally { privateDer.fill(0); }
  }
  const key = scryptSync(password, Buffer.from(row.salt, 'hex'), 32, KEY_DERIVATION);
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(row.tag, 'hex'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(row.encrypted_private_key, 'hex')), decipher.final()]);
    const privateKey = createPrivateKey({ key: plaintext, format: 'der', type: 'pkcs8' });
    if (createPublicKey(privateKey).export({ format: 'pem', type: 'spki' }).toString() !== row.public_key)
      throw new Error('dream approval key does not match its public key');
    return { privateKey, publicKey: row.public_key };
  } catch { throw new Error('dream approval key could not be unlocked; operator key recovery is required'); }
  finally { key.fill(0); plaintext?.fill(0); }
}

/** Rewrap the same signing key after the operator password changes. */
export function rekeyDreamApprovalKey(operatorPassphrase: string, tier2Passphrase: string,
  previousApprovalPassphrase: string): void {
  validateDreamOperator(operatorPassphrase, tier2Passphrase);
  if (!previousApprovalPassphrase) throw new Error('previous approval-key passphrase is required');
  const db = openDreamApprovalDatabase();
  try {
    db.transaction(() => {
      const existing = db.prepare('SELECT public_key FROM dream_approval_key WHERE id=1').get() as { public_key: string } | undefined;
      if (!existing) throw new Error('dream approval key does not exist');
      const { privateKey, publicKey } = signingKey(db, previousApprovalPassphrase);
      const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
      try {
        const wrapped = encryptPrivateKey(privateDer, operatorPassphrase, publicKey);
        const changed = db.prepare('UPDATE dream_approval_key SET salt=?,iv=?,tag=?,encrypted_private_key=? WHERE id=1 AND public_key=?')
          .run(wrapped.salt, wrapped.iv, wrapped.tag, wrapped.encrypted_private_key, publicKey);
        if (changed.changes !== 1) throw new Error('dream approval key changed concurrently');
        db.prepare('INSERT INTO dream_approval_key_audit VALUES(?,?,?,?)')
          .run('rewrap', createHash('sha256').update(publicKey).digest('hex'), 'local-operator', new Date().toISOString());
      } finally { privateDer.fill(0); }
    }).immediate();
  } finally { db.close(); }
}

export function approveDreamProposal(proposal: Proposal, operatorPassphrase: string, tier2Passphrase: string): void {
  validateDreamOperator(operatorPassphrase, tier2Passphrase);
  validateReflectionProposal(proposal);
  if (proposal.status !== 'pending') throw new Error('only a pending proposal can be approved');
  const digest = proposalApprovalDigest(proposal);
  const db = openDreamApprovalDatabase();
  try {
    db.transaction(() => {
      const existing = db.prepare('SELECT proposal_digest FROM dream_operator_approvals WHERE proposal_id=?').get(proposal.id) as { proposal_digest: string } | undefined;
      if (existing) {
        if (existing.proposal_digest !== digest || !verifyDreamApproval(db, proposal)) throw new Error('approval conflicts with the current proposal');
        return;
      }
      const { privateKey } = signingKey(db, operatorPassphrase);
      const signature = sign(null, message(digest), privateKey).toString('hex');
      db.prepare('INSERT INTO dream_operator_approvals VALUES(?,?,?,?)').run(proposal.id, digest, signature, new Date().toISOString());
    }).immediate();
  } finally { db.close(); }
}

export function verifyDreamApproval(db: Database.Database, proposal: Proposal): boolean {
  const receipt = db.prepare('SELECT proposal_digest,signature FROM dream_operator_approvals WHERE proposal_id=?').get(proposal.id) as {proposal_digest: string; signature: string} | undefined;
  const key = db.prepare('SELECT public_key FROM dream_approval_key WHERE id=1').get() as {public_key: string} | undefined;
  if (!receipt || !key || receipt.proposal_digest !== proposalApprovalDigest(proposal) || !/^[a-f0-9]{128}$/i.test(receipt.signature)) return false;
  try { return verify(null, message(receipt.proposal_digest), createPublicKey(key.public_key), Buffer.from(receipt.signature, 'hex')); }
  catch { return false; }
}

/** Public evidence for the hash-linked proposal chain; key trust must be anchored separately. */
export function dreamApprovalEvidence(proposal: Proposal): { proposalId: string; proposalDigest: string;
  signature: string; publicKey: string; approvedAt: string } {
  const db = openDreamApprovalDatabase();
  try {
    if (!verifyDreamApproval(db, proposal)) throw new Error('no valid operator signature for this proposal');
    const receipt = db.prepare('SELECT proposal_digest,signature,approved_at FROM dream_operator_approvals WHERE proposal_id=?')
      .get(proposal.id) as { proposal_digest: string; signature: string; approved_at: string };
    const key = db.prepare('SELECT public_key FROM dream_approval_key WHERE id=1').get() as { public_key: string };
    return { proposalId: proposal.id, proposalDigest: receipt.proposal_digest, signature: receipt.signature,
      publicKey: key.public_key, approvedAt: receipt.approved_at };
  } finally { db.close(); }
}
