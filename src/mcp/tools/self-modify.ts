/**
 * memphis_self_modify — Safe self-modification MCP tool (Phase C).
 *
 * Orchestrates: session → snapshot → branch → apply changes → test gate → commit/rollback.
 * Requires git — self-modification without version control is not allowed.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { RollbackManager } from '../../backup/rollback.js';
import {
  commitAll,
  createBranch,
  deleteBranch,
  getCurrentBranch,
  isGitRepo,
  mergeBranch,
  switchBranch,
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

// ── Path validation ──────────────────────────────────────────────────────────

const FORBIDDEN_SEGMENTS = ['.env', 'vault/', '.git/', 'node_modules/'];

function validateFilePath(filePath: string, projectRoot: string): string {
  const resolved = resolve(projectRoot, filePath);
  if (!resolved.startsWith(projectRoot + '/')) {
    throw new Error(`Path traversal blocked: ${filePath} resolves outside project root`);
  }
  const relative = resolved.slice(projectRoot.length + 1);
  if (relative.startsWith('.')) {
    throw new Error(`Dotfile modification blocked: ${filePath}`);
  }
  for (const seg of FORBIDDEN_SEGMENTS) {
    if (relative.includes(seg)) {
      throw new Error(`Forbidden path segment '${seg}' in: ${filePath}`);
    }
  }
  return resolved;
}

function errorResult(reason: string): SelfModifyResult {
  return {
    success: false,
    sessionId: '',
    status: 'error',
    rollbackReason: reason,
    timestamp: new Date().toISOString(),
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function runMemphisSelfModify(
  input: SelfModifyInput,
  deps: SelfModifyDeps,
): Promise<SelfModifyResult> {
  const { intent, files, changes } = input;
  const { sessionRepo, rollback, caseAdapter } = deps;
  const projectRoot = deps.projectRoot ?? process.cwd();

  // 0. Validate inputs
  if (files.length === 0 || Object.keys(changes).length === 0) {
    return errorResult('No files or changes provided');
  }

  // Validate all file paths before doing anything
  for (const f of files) {
    validateFilePath(f, projectRoot);
  }
  for (const f of Object.keys(changes)) {
    validateFilePath(f, projectRoot);
  }

  // Require git — self-modification without version control is not allowed
  if (!(await isGitRepo(projectRoot))) {
    return errorResult('Self-modification requires a git repository for safe rollback');
  }

  // Enforce evolution policy
  ensureSoulManifest();

  // 1. Create session
  const session = sessionRepo.create({ intent, filesAllowed: files });
  sessionRepo.updateStatus(session.id, 'approved');

  let originalBranch = '';
  let evolveBranch = '';

  try {
    // 2. Snapshot
    const snapshotId = await rollback.createSnapshot(`evolve: ${intent}`);

    // 3. Branch isolation
    originalBranch = await getCurrentBranch(projectRoot);
    const slug = intent
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40);
    evolveBranch = `evolve/${Date.now()}-${slug}`;
    await createBranch(evolveBranch, projectRoot);

    sessionRepo.updateStatus(session.id, 'active', {
      snapshotId,
      branch: evolveBranch,
      originalBranch,
    });

    // 4. Apply changes
    for (const [filePath, content] of Object.entries(changes)) {
      if (!files.includes(filePath)) {
        throw new Error(`File ${filePath} not in allowed list: ${files.join(', ')}`);
      }
      const fullPath = validateFilePath(filePath, projectRoot);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, 'utf-8');
    }

    // 5. Test gate (pass changed files so it knows whether to rebuild Rust)
    const changedFiles = Object.keys(changes);
    const testResult = await runTestGate(projectRoot, changedFiles);

    if (testResult.passed) {
      // 6a. Commit + merge
      const commitHash = await commitAll(`evolve: ${intent}`, projectRoot, files);
      await switchBranch(originalBranch, projectRoot);
      await mergeBranch(evolveBranch, projectRoot);
      await deleteBranch(evolveBranch, projectRoot);

      sessionRepo.updateStatus(session.id, 'committed', { committedHash: commitHash });

      try {
        await caseAdapter.appendCaseEntry({
          case_type: 'accusative',
          subject: 'agent',
          verb: 'evolved',
          object: `modified ${changedFiles.length} file(s): ${intent} [${commitHash.slice(0, 8)}]`,
        });
      } catch {
        // audit is best-effort
      }

      return {
        success: true,
        sessionId: session.id,
        status: 'committed',
        commitHash,
        testGate: testResult,
        timestamp: new Date().toISOString(),
      };
    }

    // 6b. Test failed — rollback
    const failedStep = testResult.steps.find((s) => !s.passed);
    const reason = `test gate failed at ${failedStep?.name ?? 'unknown'}: ${failedStep?.output.slice(-200) ?? ''}`;

    await switchBranch(originalBranch, projectRoot);
    await deleteBranch(evolveBranch, projectRoot);
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
