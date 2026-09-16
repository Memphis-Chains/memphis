#!/usr/bin/env node
// scripts/set-github-pat.mjs
//
// Helper for the operator (Marcin Kukla) to set a GitHub Personal Access Token
// for publishing v1.13.x commits + tags. Tier-0 utility; does NOT commit,
// log, or transmit the PAT anywhere. Writes to a secure file and verifies
// auth against GitHub.
//
// Usage:
//   node scripts/set-github-pat.mjs                  # interactive prompt
//   node scripts/set-github-pat.mjs --pat ghp_xxx    # inline (avoid transcript!)
//
// File written (mode 0600): /home/memphis/.memphis/.github-pat
// .gitignore already excludes `.github-pat` (added by this script).
//
// Exit codes:
//   0 — success, PAT saved + verified
//   1 — bad PAT format
//   2 — GitHub auth failed (PAT invalid/expired/wrong scope)
//   3 — file write failed (permissions, disk)

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

const PAT_FILE = join(homedir(), '.memphis', '.github-pat');
const GITIGNORE = '/home/memphis/memphis/.gitignore';

// --- argument parsing ---
function getArg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPatInteractive() {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  process.stderr.write('GitHub PAT: ');
  // Disable echo so PAT isn't visible in terminal
  const mutedRl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  return new Promise((resolve) => {
    let input = '';
    const handler = (line) => {
      input += line + '\n';
    };
    process.stdin.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      // Replace printable chars with '*' on the TTY (no-op for non-TTY)
      if (process.stderr.isTTY) process.stderr.write(s.replace(/[^\n]/g, '*'));
    });
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', handler);
    process.stdin.once('end', () => resolve(input.trim()));
    rl.close();
    mutedRl.close();
  });
}

function validatePat(pat) {
  if (!pat || typeof pat !== 'string') return 'empty PAT';
  const trimmed = pat.trim();
  if (trimmed.length < 20) return `too short (${trimmed.length} chars)`;
  if (trimmed.length > 200) return `too long (${trimmed.length} chars)`;
  // classic: ghp_ + 36 alphanumerics (40 chars total)
  // fine-grained: github_pat_ + 82 alphanumerics (93 chars total)
  if (trimmed.startsWith('ghp_') && /^[A-Za-z0-9_]+$/.test(trimmed) && trimmed.length >= 40 && trimmed.length <= 50) {
    return null; // valid classic
  }
  if (trimmed.startsWith('github_pat_') && /^[A-Za-z0-9_]+$/.test(trimmed) && trimmed.length >= 90 && trimmed.length <= 110) {
    return null; // valid fine-grained
  }
  return 'format unrecognised — expected ghp_… (classic) or github_pat_… (fine-grained)';
}

async function verifyGitHubAuth(pat) {
  // Use GitHub API to verify the token works and has correct scope.
  const r = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'memphis-set-github-pat',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    return { ok: false, status: r.status, body: body.slice(0, 200) };
  }
  const data = await r.json();
  // Check token scopes (only returned for classic tokens via X-OAuth-Scopes header)
  const scopes = r.headers.get('x-oauth-scopes') ?? '';
  return {
    ok: true,
    login: data.login,
    name: data.name,
    scopes: scopes.split(',').map((s) => s.trim()).filter(Boolean),
    tokenType: data.type ?? 'classic',
  };
}

function ensureGitignore() {
  // Add `.github-pat` and `*.github-pat` to .gitignore if not already there.
  let text = '';
  try {
    text = readFileSync(GITIGNORE, 'utf8');
  } catch {
    return; // gitignore missing — strange but don't fail the script
  }
  const rules = ['.github-pat', '*.github-pat'];
  let mutated = false;
  for (const r of rules) {
    const line = r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${line}$`, 'm');
    if (!re.test(text)) {
      text = text.endsWith('\n') ? text + r + '\n' : text + '\n' + r + '\n';
      mutated = true;
    }
  }
  if (mutated) {
    writeFileSync(GITIGNORE, text, 'utf8');
    console.error(`[set-github-pat] appended ${rules.length} rule(s) to .gitignore`);
  }
}

async function main() {
  let pat = getArg('pat');
  if (!pat) {
    if (!process.stdin.isTTY) {
      console.error('[set-github-pat] no --pat and stdin is not a TTY — pass PAT inline:');
      console.error('  node scripts/set-github-pat.mjs --pat ghp_xxx');
      process.exit(1);
    }
    console.error('[set-github-pat] reading PAT from TTY (input will be masked)…');
    pat = await readPatInteractive();
  }

  const err = validatePat(pat);
  if (err) {
    console.error(`[set-github-pat] invalid PAT: ${err}`);
    process.exit(1);
  }
  pat = pat.trim();

  console.error('[set-github-pat] verifying PAT against GitHub API…');
  const auth = await verifyGitHubAuth(pat);
  if (!auth.ok) {
    console.error(`[set-github-pat] GitHub auth failed: HTTP ${auth.status}`);
    console.error(`  body: ${auth.body}`);
    console.error('  → PAT may be invalid, expired, or revoked.');
    process.exit(2);
  }
  console.error(
    `[set-github-pat] auth OK: login=${auth.login}` +
      (auth.scopes.length ? ` scopes=[${auth.scopes.join(', ')}]` : ` (fine-grained token)`),
  );
  if (auth.scopes.length && !auth.scopes.includes('repo')) {
    console.error('[set-github-pat] WARNING: token does not have "repo" scope — push will fail.');
    console.error('  regenerate at https://github.com/settings/tokens/new with repo enabled.');
    // Continue anyway — let the user decide.
  }

  // Atomic write: tmp + rename + chmod 600.
  const tmpFile = PAT_FILE + '.tmp-' + process.pid;
  try {
    writeFileSync(tmpFile, pat + '\n', { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmpFile, 0o600);
    // rename
    const { renameSync } = await import('node:fs');
    renameSync(tmpFile, PAT_FILE);
    chmodSync(PAT_FILE, 0o600);
  } catch (e) {
    console.error(`[set-github-pat] write failed: ${e.message}`);
    process.exit(3);
  }

  ensureGitignore();

  console.error(`[set-github-pat] wrote ${PAT_FILE} (mode 0600, owned by ${process.env.USER ?? '?'})`);
  console.error('[set-github-pat] next steps:');
  console.error('  export GH_TOKEN=$(cat ~/.memphis/.github-pat)  # load into shell');
  console.error('  gh issue create --repo Memphis-Chains/memphis --body-file /tmp/gh-issue-body.md …');
  console.error('  git push https://x-access-token:$(cat ~/.memphis/.github-pat)@github.com/Memphis-Chains/memphis.git feat/can-self-modify-computed v1.13.2');
  console.error('[set-github-pat] done.');
  // Brief structured summary on stdout for log capture.
  process.stdout.write(JSON.stringify({ ok: true, login: auth.login, path: PAT_FILE }) + '\n');
}

main().catch((e) => {
  console.error('[set-github-pat] fatal:', e.message);
  process.exit(99);
});
