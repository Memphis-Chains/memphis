import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { evolveGit } from './evolve-review.js';
import { getDataDir } from '../../config/paths.js';
import { recordDecisionHistoryEntry } from '../../core/decision-history-store.js';
import { createDecision } from '../../core/decision-lifecycle.js';

export async function createEvolveWorktree(root: string, id: string, rawEnv?: NodeJS.ProcessEnv): Promise<{
  root: string; worktree: string; target: string; base: string; branch: string;
}> {
  root = realpathSync(resolve(root));
  if (realpathSync(await evolveGit(root, ['rev-parse', '--show-toplevel'])) !== root)
    throw new Error('self-modification requires the repository root');
  const target = await evolveGit(root, ['branch', '--show-current']);
  if (!target || await evolveGit(root, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('self-modification requires a clean checked-out target branch');
  const base = await evolveGit(root, ['rev-parse', 'HEAD']);
  const branch = `evolve/review-${id}`;
  const worktree = join(getDataDir(rawEnv), 'state', 'evolve-worktrees', id);
  mkdirSync(dirname(worktree), { recursive: true, mode: 0o700 });
  await evolveGit(root, ['worktree', 'add', '-b', branch, worktree, base]);
  // Node dependencies are not committed. Share the existing installation,
  // never install packages or touch its contents as part of preparation.
  const deps = join(root, 'node_modules');
  if (existsSync(deps) && !existsSync(join(worktree, 'node_modules'))) symlinkSync(deps, join(worktree, 'node_modules'), 'dir');
  return { root, worktree, target, base, branch };
}

export async function commitEvolveWorktree(worktree: string, allowed: string[], intent: string,
  rawEnv?: NodeJS.ProcessEnv): Promise<string> {
  if (allowed.length === 0) throw new Error('no approved paths');
  for (const file of allowed) {
    const name = basename(file);
    if (name === '.env' || name.startsWith('.env.') || name === 'vault-state.json' ||
        name === '.github-pat' || name.endsWith('.tier2-passphrase') ||
        file.split('/').some((part) => part === 'dist' || part === 'node_modules'))
      throw new Error(`forbidden staged path: ${file}`);
  }
  await evolveGit(worktree, ['add', '--', ...allowed]);
  const staged = (await evolveGit(worktree, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (!staged.length || staged.some((file) => !allowed.includes(file))) throw new Error('staged paths differ from approved paths');
  if (await evolveGit(worktree, ['diff', '--name-only']) ||
      await evolveGit(worktree, ['ls-files', '--others', '--exclude-standard']))
    throw new Error('tests or another writer changed files outside the staged proposal');
  const links = new Set<string>();
  for (const file of staged) {
    const content = readFileSync(join(worktree, file), 'utf8');
    for (const match of content.matchAll(/docs\/postmortems\/\d{4}-\d{2}-\d{2}-[a-zA-Z0-9._-]+\.md/g)) links.add(match[0]);
  }
  const name = await evolveGit(worktree, ['config', 'user.name']);
  const email = await evolveGit(worktree, ['config', 'user.email']);
  if (!name || !email || /[\r\n<>]/.test(name + email)) throw new Error('valid Git author identity is required');
  const decision = createDecision({ id: `evolve-culture-${createHash('sha256').update(intent).digest('hex').slice(0, 16)}-${Date.now()}`,
    title: 'Prepare supervised evolution commit', chosen: 'Apply manual commit culture checks', options: ['Apply manual commit culture checks'],
    context: 'commit_culture is unavailable; record this decision before the proposal commit.' });
  const recorded = await recordDecisionHistoryEntry(decision, { source: 'evolve', rawEnv });
  if (!recorded.chainRef) throw new Error('commit culture decision was not recorded');
  const body = [`Manual commit culture check; commit_culture audit hook is unavailable.`,
    `Decision: decisions#${recorded.chainRef.index}`, ...Array.from(links).sort().map((link) => `See: ${link}`),
    '', `Co-authored-by: ${name} <${email}>`].join('\n');
  await evolveGit(worktree, ['commit', '-m', 'fix(runtime): prepare supervised change', '-m', body]);
  const identities = (await evolveGit(worktree, ['log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce'])).split('\0');
  if (identities.length !== 4 || identities[0] !== name || identities[1] !== email || identities[2] !== name || identities[3] !== email)
    throw new Error('commit author or committer differs from the reviewed Git identity');
  return evolveGit(worktree, ['rev-parse', 'HEAD']);
}
