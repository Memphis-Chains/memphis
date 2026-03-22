/**
 * Git utilities for evolution branch isolation.
 *
 * Uses child_process directly — no external dependencies.
 */

import { execFile } from 'node:child_process';

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function isGitRepo(cwd?: string): Promise<boolean> {
  try {
    await git(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentBranch(cwd?: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
}

export async function createBranch(branchName: string, cwd?: string): Promise<void> {
  await git(['checkout', '-b', branchName], cwd);
}

export async function switchBranch(branchName: string, cwd?: string): Promise<void> {
  await git(['checkout', branchName], cwd);
}

export async function commitAll(message: string, cwd?: string): Promise<string> {
  await git(['add', '-A'], cwd);
  await git(['commit', '-m', message, '--allow-empty'], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

export async function mergeBranch(branchName: string, cwd?: string): Promise<void> {
  await git(['merge', branchName, '--no-ff', '-m', `merge: ${branchName}`], cwd);
}

export async function deleteBranch(branchName: string, cwd?: string): Promise<void> {
  await git(['branch', '-D', branchName], cwd);
}

export async function hasUncommittedChanges(cwd?: string): Promise<boolean> {
  const status = await git(['status', '--porcelain'], cwd);
  return status.length > 0;
}

export async function stashChanges(cwd?: string): Promise<boolean> {
  try {
    const result = await git(['stash', 'push', '-m', 'memphis-evolve-pre-snapshot'], cwd);
    return !result.includes('No local changes');
  } catch {
    return false;
  }
}

export async function stashPop(cwd?: string): Promise<void> {
  await git(['stash', 'pop'], cwd);
}
