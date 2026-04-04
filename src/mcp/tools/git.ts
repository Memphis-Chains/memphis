/**
 * memphis_git — git workflow tool for status, diff, log, and safe write operations.
 *
 * Tier 1 subcommands: status, log, diff, show, branch, blame, shortlog
 * Tier 2 subcommands: add, commit, push, pull, checkout, switch, merge, rebase
 *
 * Restricted to ~/memphis/ repository.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export type MemphisGitInput = {
  /** Git subcommand (e.g. "status", "log", "diff", "add", "commit") */
  subcommand: string;
  /** Arguments to pass to the subcommand */
  args?: string[];
};

export type MemphisGitOutput = {
  output: string;
  truncated: boolean;
  error?: string;
};

const PROJECT_ROOT = path.join(os.homedir(), 'memphis');
const MAX_OUTPUT_CHARS = 200_000;

/** Read-only subcommands — available at tier 1 */
const READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'blame',
  'shortlog', 'reflog', 'tag', 'describe', 'rev-parse',
  'ls-files', 'remote', 'stash',
]);

/** Write subcommands — require tier 2 */
const WRITE_SUBCOMMANDS = new Set([
  'add', 'commit', 'push', 'pull', 'fetch', 'checkout',
  'switch', 'merge', 'rebase', 'reset', 'init', 'clone',
]);

/** Dangerous patterns that should never appear in arguments */
const BLOCKED_ARGS = [
  '--exec', '--upload-pack', '--receive-pack',
  '-c', // arbitrary config
];

export function getGitSubcommandTier(subcommand: string): 0 | 1 | 2 {
  if (READ_SUBCOMMANDS.has(subcommand)) return 1;
  if (WRITE_SUBCOMMANDS.has(subcommand)) return 2;
  return 2; // unknown = highest tier
}

export function runMemphisGit(input: MemphisGitInput): MemphisGitOutput {
  if (!input.subcommand) {
    return { output: '', truncated: false, error: 'subcommand required' };
  }

  const sub = input.subcommand.toLowerCase().trim();
  if (!READ_SUBCOMMANDS.has(sub) && !WRITE_SUBCOMMANDS.has(sub)) {
    return {
      output: '',
      truncated: false,
      error: `git subcommand '${sub}' is not allowed. Allowed: ${[...READ_SUBCOMMANDS, ...WRITE_SUBCOMMANDS].join(', ')}`,
    };
  }

  const args = input.args ?? [];

  // Block dangerous arguments
  for (const arg of args) {
    for (const blocked of BLOCKED_ARGS) {
      if (arg === blocked || arg.startsWith(blocked + '=')) {
        return { output: '', truncated: false, error: `argument '${arg}' is blocked for security` };
      }
    }
    // Block shell metacharacters in arguments
    // eslint-disable-next-line no-control-regex
    if (/[;&|`$(){}[\]!#~<>\\'\n\r\x00-\x1f\x7f]/.test(arg)) {
      return { output: '', truncated: false, error: `argument contains blocked characters: '${arg}'` };
    }
  }

  try {
    const output = execFileSync('git', [sub, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      cwd: PROJECT_ROOT,
    });

    const truncated = output.length > MAX_OUTPUT_CHARS;
    const content = truncated
      ? output.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)'
      : output;

    return { output: content, truncated };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const message = stderr || (err instanceof Error ? err.message : String(err));
    return { output: '', truncated: false, error: message.slice(0, 2000) };
  }
}
