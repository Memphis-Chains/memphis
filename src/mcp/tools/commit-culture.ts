/**
 * memphis_commit_culture — culture-aware commit helper.
 *
 * Skeleton implementation. Full feature set documented in
 * docs/dev/commit-culture-interface.md.
 *
 * Tier: 2 (write). Restricted to ~/memphis/.
 *
 * NOT YET WIRED — design draft 2026-09-22. Do not register in
 * src/mcp/server.ts until tests + audit hook land.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const PROJECT_ROOT = path.join(os.homedir(), 'memphis');

/** Forbidden basenames/patterns — committed these would leak secrets or bloat history. */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\..+$/,
  /(^|\/)vault-state\.json$/,
  /(^|\/)\.tier2-passphrase$/,
  /(^|\/)\.github-pat$/,
  /\.tier2-passphrase$/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
];

const ALLOWED_TYPES = new Set([
  'feat',
  'fix',
  'ci',
  'docs',
  'refactor',
  'test',
  'chore',
  'perf',
  'build',
]);

const SUBJECT_REGEX = /^[a-z].{2,79}$/; // 3-80 chars, lowercase first letter
const SCOPE_REGEX = /^[a-z0-9_-]+$/;

export type CommitCultureInput = {
  subcommand?: 'auto' | 'preview' | 'dry-run' | 'amend';
  type?: string;
  scope?: string;
  subject?: string;
  body?: string;
  link?: string[];
  coAuthor?: string[];
  noVerify?: boolean;
  allowStagedNovel?: boolean;
};

export type CommitCultureOutput = {
  ok: boolean;
  stage: 'previewed' | 'committed' | 'rejected';
  message?: string;
  files?: string[];
  reason?: string;
  hash?: string;
};

export function runMemphisCommitCulture(input: CommitCultureInput): CommitCultureOutput {
  const cwd = PROJECT_ROOT;

  // 1. Gather staged files (skip for amend — handled separately later)
  let staged: string[];
  try {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], {
      encoding: 'utf8',
      cwd,
      timeout: 10_000,
    });
    staged = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    return { ok: false, stage: 'rejected', reason: `git diff failed: ${String(err)}` };
  }

  if (staged.length === 0 && input.subcommand !== 'amend') {
    return { ok: false, stage: 'rejected', reason: 'no staged files' };
  }

  // 2. Forbidden-files check
  if (!input.allowStagedNovel) {
    for (const f of staged) {
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.test(f)) {
          return {
            ok: false,
            stage: 'rejected',
            reason: `forbidden file in stage: ${f}`,
          };
        }
      }
    }
  }

  // 3. Type/scope/subject validation
  if (input.type && !ALLOWED_TYPES.has(input.type)) {
    return { ok: false, stage: 'rejected', reason: `invalid type: ${input.type}` };
  }
  if (input.scope && !SCOPE_REGEX.test(input.scope)) {
    return { ok: false, stage: 'rejected', reason: `invalid scope: ${input.scope}` };
  }
  if (input.subject && !SUBJECT_REGEX.test(input.subject)) {
    return { ok: false, stage: 'rejected', reason: `subject must match ${SUBJECT_REGEX}` };
  }

  // 4. Build message
  const type = input.type ?? 'fix'; // default; auto-detect later
  const scope = input.scope ?? inferScope(staged);
  const subject = input.subject ?? ''; // auto-mode will fill later
  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
  const trailers: string[] = [];
  for (const link of input.link ?? []) trailers.push(`See: ${link}`);
  for (const ca of input.coAuthor ?? []) trailers.push(`Co-authored-by: ${ca}`);
  const body = [input.body ?? '', ...trailers].filter(Boolean).join('\n\n');

  const fullMessage = body ? `${header}\n\n${body}` : header;

  // 5. Preview vs commit
  if (input.subcommand === 'preview' || input.subcommand === 'dry-run') {
    return {
      ok: true,
      stage: 'previewed',
      message: fullMessage,
      files: staged,
    };
  }

  // 6. Commit
  try {
    const args = ['commit', '-m', header];
    if (body) args.push('-m', body);
    if (input.noVerify) args.push('--no-verify');
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      cwd,
      timeout: 120_000,
    });
    const hashMatch = out.match(/\[[\w/]+ ([a-f0-9]+)\]/);
    return {
      ok: true,
      stage: 'committed',
      message: fullMessage,
      files: staged,
      hash: hashMatch?.[1],
    };
  } catch (err) {
    return { ok: false, stage: 'rejected', reason: `git commit failed: ${String(err)}` };
  }
}

function inferScope(staged: string[]): string {
  const counts = new Map<string, number>();
  for (const f of staged) {
    const top = f.split('/')[0];
    if (top) counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] ?? '';
}
