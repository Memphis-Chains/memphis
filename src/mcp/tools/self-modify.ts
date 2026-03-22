/**
 * memphis_self_modify — Safe self-modification MCP tool (Phase C).
 *
 * Orchestrates: session → snapshot → branch → apply changes → test gate → commit/rollback.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { RollbackManager } from '../../backup/rollback.js';
import {
  createBranch,
  commitAll,
  getCurrentBranch,
  switchBranch,
  deleteBranch,
  isGitRepo,
} from '../../infra/git-utils.js';
import { CaseChainAdapter } from '../../infra/storage/case-chain-adapter.js';
import { SqliteEvolveSessionRepository } from '../../infra/storage/sqlite/repositories/evolve-session-repository.js';
import { runTestGate, type TestGateResult } from '../../infra/test-gate.js';
import { ensureSoulManifest } from '../../soul/manifest.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SelfModifyInput {
  intent: string;
  files: string[];
  changes: Record<string, string>;
}

export interface SelfModifyResult {
  success: boolean;
  sessionId: string;
  status: 'committed' | 'rolled-back' | 'error';
  commitHash?: string;
  branch?: string;
  rollbackReason?: string;
  testGate?: TestGateResult;
  timestamp: string;
}

export interface SelfModifyDeps {
  sessionRepo: SqliteEvolveSessionRepository;
  rollback: RollbackManager;
  caseAdapter: CaseChainAdapter;
  projectRoot?: string;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runMemphisSelfModify(
  input: SelfModifyInput,
  deps: SelfModifyDeps,
): Promise<SelfModifyResult> {
  const { intent, files, changes } = input;
  const { sessionRepo, rollback, caseAdapter } = deps;
  const projectRoot = deps.projectRoot ?? process.cwd();

  // 0. Validate
  if (files.length === 0 || Object.keys(changes).length === 0) {
    return {
      success: false,
      sessionId: '',
      status: 'error',
      rollbackReason: 'No files or changes provided',
      timestamp: new Date().toISOString(),
    };
  }

  // Enforce evolution policy
  const manifest = ensureSoulManifest();
  if (!manifest.evolution.snapshotBeforeEvolution) {
    // Even if disabled, we snapshot anyway — safety first. Just log it.
  }

  // 1. Create session
  const session = sessionRepo.create({ intent, filesAllowed: files });
  sessionRepo.updateStatus(session.id, 'approved');

  let originalBranch: string | null = null;
  let evolveBranch: string | null = null;

  try {
    // 2. Snapshot
    const snapshotId = await rollback.createSnapshot(`evolve: ${intent}`);
    sessionRepo.updateStatus(session.id, 'active', { snapshotId });

    // 3. Branch isolation (if git repo)
    const inGit = await isGitRepo(projectRoot);
    if (inGit) {
      originalBranch = await getCurrentBranch(projectRoot);
      const slug = intent
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 40);
      evolveBranch = `evolve/${Date.now()}-${slug}`;
      await createBranch(evolveBranch, projectRoot);
      sessionRepo.updateStatus(session.id, 'active', { branch: evolveBranch });
    }

    // 4. Apply changes
    for (const [filePath, content] of Object.entries(changes)) {
      if (!files.includes(filePath)) {
        throw new Error(`File ${filePath} not in allowed list: ${files.join(', ')}`);
      }
      const fullPath = filePath.startsWith('/') ? filePath : `${projectRoot}/${filePath}`;
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }

    // 5. Test gate
    const testResult = await runTestGate(projectRoot);

    if (testResult.passed) {
      // 6a. Commit
      let commitHash: string | undefined;
      if (inGit) {
        commitHash = await commitAll(`evolve: ${intent}`, projectRoot);

        // Merge back to original branch
        await switchBranch(originalBranch!, projectRoot);
        const { mergeBranch: mergeEvolveBranch } = await import('../../infra/git-utils.js');
        await mergeEvolveBranch(evolveBranch!, projectRoot);
        await deleteBranch(evolveBranch!, projectRoot);
        evolveBranch = null; // merged, no cleanup needed
      }

      sessionRepo.updateStatus(session.id, 'committed', { committedHash: commitHash });

      // Audit
      try {
        await caseAdapter.appendCaseEntry({
          case_type: 'accusative',
          subject: 'agent',
          verb: 'evolved',
          object: `modified ${Object.keys(changes).length} file(s): ${intent}${commitHash ? ` [${commitHash.slice(0, 8)}]` : ''}`,
        });
      } catch {
        // audit is best-effort
      }

      return {
        success: true,
        sessionId: session.id,
        status: 'committed',
        commitHash,
        branch: evolveBranch ?? undefined,
        testGate: testResult,
        timestamp: new Date().toISOString(),
      };
    }

    // 6b. Test failed — rollback
    const failedStep = testResult.steps.find((s) => !s.passed);
    const reason = `test gate failed at ${failedStep?.name ?? 'unknown'}: ${failedStep?.output.slice(-200) ?? ''}`;

    if (inGit && originalBranch) {
      await switchBranch(originalBranch, projectRoot);
      if (evolveBranch) {
        await deleteBranch(evolveBranch, projectRoot);
        evolveBranch = null;
      }
    }

    await rollback.rollback(snapshotId);
    sessionRepo.updateStatus(session.id, 'rolled-back', { errorMessage: reason });

    try {
      await caseAdapter.appendCaseEntry({
        case_type: 'accusative',
        subject: 'agent',
        verb: 'rolled-back',
        object: `evolution failed: ${reason.slice(0, 200)}`,
      });
    } catch {
      // audit is best-effort
    }

    return {
      success: false,
      sessionId: session.id,
      status: 'rolled-back',
      rollbackReason: reason,
      testGate: testResult,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    // Catastrophic failure — rollback everything
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (originalBranch) {
      try {
        await switchBranch(originalBranch, projectRoot);
        if (evolveBranch) await deleteBranch(evolveBranch, projectRoot);
      } catch {
        // best-effort branch cleanup
      }
    }

    const snap = sessionRepo.getById(session.id);
    if (snap?.snapshotId) {
      try {
        await rollback.rollback(snap.snapshotId);
      } catch {
        // best-effort snapshot rollback
      }
    }

    sessionRepo.updateStatus(session.id, 'rolled-back', {
      errorMessage: `exception: ${errorMsg}`,
    });

    return {
      success: false,
      sessionId: session.id,
      status: 'error',
      rollbackReason: errorMsg,
      timestamp: new Date().toISOString(),
    };
  }
}
