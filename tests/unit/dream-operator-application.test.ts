import { createHash } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approveDreamProposal, dreamApprovalDatabasePath, openDreamApprovalDatabase, proposalApprovalDigest, rekeyDreamApprovalKey, verifyDreamApproval } from '../../src/cognitive/dreaming/operator-approval.js';
import { appendProposal, appendSignedAcceptance, proposalBlockData, readProposals } from '../../src/cognitive/dreaming/proposal-chain.js';
import { createProposal, transitionProposal } from '../../src/cognitive/dreaming/proposal-lifecycle.js';
import { applyDreamSoulProposal, dreamApplicationStatus, reconcileDreamSoulProposal, rollbackDreamSoulProposal } from '../../src/cognitive/dreaming/soul-proposal-application.js';
import { hashWithSalt, saveOperatorConfig } from '../../src/infra/auth/operator-gate.js';
import { appendBlockConditional } from '../../src/infra/storage/chain-adapter.js';
import { generateSoulManifest, loadSoulManifest, writeSoulManifest } from '../../src/soul/manifest.js';
import { emptySoulMemory, loadSoulMemory, updateSoulMemory, writeSoulMemory } from '../../src/soul/memory.js';

const OPERATOR = 'synthetic-operator-password';
const TIER2 = 'synthetic-separate-tier2';
const SALT = 'synthetic-salt';
const OPERATOR_HASH = hashWithSalt(OPERATOR, SALT);

function proposal() {
  return createProposal({ id: `reflection:${'a'.repeat(64)}`, kind: 'memory.update',
    target: { scope: 'soul-memory' }, patch: { self: { learnings: ['fixture learning'] } },
    evidence: [{ sessionId: 'chain:journal', sequence: 5, quote: `source block ${'b'.repeat(64)}` }],
    prevalence: { occurrences: 1, sessions: 1, spanDays: 1, denominator: 1 },
    confidence: 0, rationale: 'synthetic reflection', proposer: 'agent',
    basedOn: { sessionIds: [], chainBlockHashes: ['b'.repeat(64)] },
  });
}

describe('operator-approved soul proposals', () => {
  beforeEach(() => {
    const data = mkdtempSync(join(tmpdir(), 'memphis-dream-approval-'));
    vi.stubEnv('MEMPHIS_DATA_DIR', data);
    vi.stubEnv('MEMPHIS_HOME', data);
    vi.stubEnv('RUST_CHAIN_ENABLED', 'false');
    saveOperatorConfig({ schemaVersion: 1, passphraseHash: OPERATOR_HASH, salt: SALT,
      createdAt: '', updatedAt: '', recoveryQuestionHint: '', recoveryHash: '' });
    const manifest = generateSoulManifest(process.env);
    manifest.evolution.requirePassphraseForTier2 = true;
    manifest.evolution.passphraseHash = createHash('sha256').update(TIER2).digest('hex');
    writeSoulManifest(manifest, process.env);
    writeSoulMemory(emptySoulMemory());
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires the operator credential for both checks in explicit operator mode', () => {
    const manifest = loadSoulManifest()!;
    manifest.evolution.tier2AuthMode = 'operator';
    writeSoulManifest(manifest);
    const p = proposal();
    expect(() => approveDreamProposal(p, OPERATOR, 'wrong')).toThrow(/Tier 2/);
    expect(() => approveDreamProposal(p, OPERATOR, OPERATOR)).not.toThrow();
  }, 20_000);

  it('rejects forged approvals, wrong passwords, and altered material', async () => {
    const p = proposal();
    const forged = transitionProposal(p, 'accepted');
    await appendProposal(forged);
    await expect(applyDreamSoulProposal(forged)).rejects.toThrow(/operator signature/);
    expect(() => approveDreamProposal(p, 'wrong', TIER2)).toThrow(/authentication/);
    expect(() => approveDreamProposal(p, OPERATOR, 'wrong')).toThrow(/Tier 2/);
    approveDreamProposal(p, OPERATOR, TIER2);
    const altered = { ...forged, patch: { self: { learnings: ['different'] } } };
    await expect(applyDreamSoulProposal(altered)).rejects.toThrow(/content changed/);
    expect(loadSoulMemory()?.self.learnings).toEqual([]);
    expect(statSync(dreamApprovalDatabasePath()).mode & 0o077).toBe(0);
    const db = openDreamApprovalDatabase();
    expect(verifyDreamApproval(db, forged)).toBe(true);
    expect(verifyDreamApproval(db, altered)).toBe(false);
    db.close();
  }, 20_000);

  it('applies once, records provenance, and rolls back only an unchanged image', async () => {
    const p = proposal();
    await appendProposal(p);
    approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted');
    await appendProposal(accepted);
    expect(await applyDreamSoulProposal(accepted)).toBe('applied');
    expect(loadSoulMemory()?.self.learnings).toEqual(['fixture learning']);
    expect(dreamApplicationStatus(p.id)?.status).toBe('applied');
    expect(await applyDreamSoulProposal(accepted)).toBe('already-applied');
    expect(loadSoulMemory()?.self.learnings).toEqual(['fixture learning']);
    const applied = (await readProposals()).find((item) => item.id === p.id)!;
    expect(applied.status).toBe('applied');
    expect(await rollbackDreamSoulProposal(applied, OPERATOR, TIER2)).toBe('rolled-back');
    expect(loadSoulMemory()?.self.learnings).toEqual([]);
    expect(dreamApplicationStatus(p.id)?.status).toBe('rolled-back');
  }, 20_000);

  it('does not overwrite intervening operator updates during rollback', async () => {
    const p = proposal(); await appendProposal(p); approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted'); await appendProposal(accepted);
    await applyDreamSoulProposal(accepted);
    updateSoulMemory({ user: { preferences: ['later operator update'] } });
    const applied = (await readProposals()).find((item) => item.id === p.id)!;
    await expect(rollbackDreamSoulProposal(applied, OPERATOR, TIER2)).rejects.toThrow(/changed since/);
    expect(loadSoulMemory()?.user.preferences).toEqual(['later operator update']);
    expect(loadSoulMemory()?.self.learnings).toEqual(['fixture learning']);
  }, 20_000);

  it('refuses to replay an ambiguous staged application', async () => {
    const p = proposal(); approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted');
    await appendProposal(accepted);
    // Materialize the journal schema without changing memory.
    expect(dreamApplicationStatus(p.id)).toBeNull();
    const db = openDreamApprovalDatabase();
    db.prepare("INSERT INTO dream_soul_applications VALUES(?,?,'staged',?,?,?,?)")
      .run(p.id, 'synthetic-unknown', '{}', 'a'.repeat(64), 'b'.repeat(64), new Date().toISOString());
    db.close();
    await expect(applyDreamSoulProposal(accepted)).rejects.toThrow(/ambiguous/);
    expect(loadSoulMemory()?.self.learnings).toEqual([]);
  }, 20_000);

  it('reconciles a staged crash only when memory matches a recorded image', async () => {
    const p = proposal(); approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted'); await appendProposal(accepted);
    expect(dreamApplicationStatus(p.id)).toBeNull();
    const before = JSON.stringify(loadSoulMemory());
    const beforeHash = createHash('sha256').update(before).digest('hex');
    const db = openDreamApprovalDatabase();
    db.prepare("INSERT INTO dream_soul_applications VALUES(?,?,'staged',?,?,?,?)")
      .run(p.id, proposalApprovalDigest(p), before, beforeHash, 'a'.repeat(64), new Date().toISOString());
    db.close();
    await expect(reconcileDreamSoulProposal(accepted, OPERATOR, 'wrong')).rejects.toThrow(/Tier 2/);
    expect(await reconcileDreamSoulProposal(accepted, OPERATOR, TIER2)).toBe('not-applied');
    expect(await applyDreamSoulProposal(accepted)).toBe('applied');
    const verify = openDreamApprovalDatabase();
    expect(verify.prepare('SELECT from_status,to_status,actor FROM dream_soul_recovery_audit').all())
      .toEqual([{ from_status: 'staged', to_status: 'not-applied', actor: 'local-operator' }]);
    verify.close();
  }, 20_000);

  it('does not reconcile a staged crash when memory differs from both images', async () => {
    const p = proposal(); approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted'); await appendProposal(accepted);
    expect(dreamApplicationStatus(p.id)).toBeNull();
    const before = JSON.stringify(loadSoulMemory());
    const db = openDreamApprovalDatabase();
    db.prepare("INSERT INTO dream_soul_applications VALUES(?,?,'staged',?,?,?,?)")
      .run(p.id, proposalApprovalDigest(p), before, createHash('sha256').update(before).digest('hex'), 'a'.repeat(64), new Date().toISOString());
    db.close();
    updateSoulMemory({ user: { preferences: ['other change'] } });
    await expect(reconcileDreamSoulProposal(accepted, OPERATOR, TIER2)).rejects.toThrow(/neither/);
    expect(dreamApplicationStatus(p.id)?.status).toBe('staged');
    expect(loadSoulMemory()?.user.preferences).toEqual(['other change']);
  }, 20_000);

  it('does not apply or revive a proposal superseded while application waits for the chain lock', async () => {
    const p = proposal(); approveDreamProposal(p, OPERATOR, TIER2);
    const accepted = transitionProposal(p, 'accepted'); await appendProposal(accepted);
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const supersede = appendBlockConditional('proposals', async () => {
      entered(); await gate;
      return { data: proposalBlockData(transitionProposal(accepted, 'superseded')), value: undefined };
    });
    await ready;
    const applying = applyDreamSoulProposal(accepted).then(
      () => ({ ok: true, error: '' }), (error: Error) => ({ ok: false, error: error.message }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    release(); await supersede;
    const result = await applying;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/must be accepted/);
    expect(loadSoulMemory()?.self.learnings).toEqual([]);
    expect((await readProposals())[0]?.status).toBe('superseded');
  }, 20_000);

  it('does not overwrite a rejection while signed acceptance waits for the chain lock', async () => {
    const p = proposal(); await appendProposal(p); approveDreamProposal(p, OPERATOR, TIER2);
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rejection = appendBlockConditional('proposals', async () => {
      entered(); await gate;
      return { data: proposalBlockData(transitionProposal(p, 'rejected')), value: undefined };
    });
    await ready;
    const acceptance = appendSignedAcceptance(p).then(
      () => ({ ok: true, error: '' }), (error: Error) => ({ ok: false, error: error.message }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    release(); await rejection;
    const result = await acceptance;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/changed before acceptance/);
    expect((await readProposals())[0]?.status).toBe('rejected');
    expect(loadSoulMemory()?.self.learnings).toEqual([]);
  }, 20_000);

  it('rewraps the same key after an operator password change without invalidating approvals', () => {
    const first = proposal(); approveDreamProposal(first, OPERATOR, TIER2);
    const initial = openDreamApprovalDatabase();
    const publicBefore = (initial.prepare('SELECT public_key FROM dream_approval_key WHERE id=1').get() as {public_key: string}).public_key;
    initial.close();
    const nextPassword = 'synthetic-new-operator-password';
    saveOperatorConfig({ schemaVersion: 1, passphraseHash: hashWithSalt(nextPassword, SALT), salt: SALT,
      createdAt: '', updatedAt: '', recoveryQuestionHint: '', recoveryHash: '' });
    expect(() => rekeyDreamApprovalKey(nextPassword, TIER2, 'wrong')).toThrow(/could not be unlocked/);
    rekeyDreamApprovalKey(nextPassword, TIER2, OPERATOR);
    const next = { ...proposal(), id: `reflection:${'c'.repeat(64)}` };
    approveDreamProposal(next, nextPassword, TIER2);
    const db = openDreamApprovalDatabase();
    expect((db.prepare('SELECT public_key FROM dream_approval_key WHERE id=1').get() as {public_key: string}).public_key).toBe(publicBefore);
    expect(verifyDreamApproval(db, first)).toBe(true);
    expect(verifyDreamApproval(db, next)).toBe(true);
    expect(db.prepare('SELECT action,actor FROM dream_approval_key_audit').all())
      .toEqual([{ action: 'rewrap', actor: 'local-operator' }]);
    db.close();
  }, 20_000);
});
