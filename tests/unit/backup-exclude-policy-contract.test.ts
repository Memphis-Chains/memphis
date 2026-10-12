import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKUP_EXCLUDE_PATTERNS,
  FALLBACK_EXCLUDE_NAMES,
} from '../../src/infra/cli/commands/backup.js';

const RUNNER = 'scripts/scheduled-backup-runner.mjs';
const POLICY = 'scripts/backup-exclude-policy.json';

function readPolicy(): { excludePatterns: string[] } {
  return JSON.parse(readFileSync(POLICY, 'utf8'));
}

function tarPatternArgs(): string[] {
  return BACKUP_EXCLUDE_PATTERNS.filter((p) => p.startsWith('--exclude='));
}

describe('backup exclude policy — one source of truth for every archiver', () => {
  it('declares glob excludes, never literal vault paths', () => {
    const joined = readPolicy().excludePatterns.join(' ');
    expect(joined).toContain('--exclude=*/vault-entries.json*');
    expect(joined).toContain('--exclude=*/vault-state.json*');
    // The literal-path defect: caught `vault-entries.json` but never
    // `vault-entries.json.bak-diag-*`. Any bare `*.json` tail is banned.
    for (const pattern of readPolicy().excludePatterns) {
      expect(pattern).not.toMatch(/--exclude=\.\/vault-entries\.json$/);
      expect(pattern).not.toMatch(/--exclude=\.\/vault-state\.json$/);
    }
  });

  it('excludes suffixed variants of secrets (bak, tmp, old, swp)', () => {
    const joined = readPolicy().excludePatterns.join(' ');
    for (const secret of ['vault-entries.json', 'vault-state.json']) {
      expect(joined).toContain(`--exclude=*/${secret}*`);
    }
    expect(joined).toContain('--exclude=*/.tier2-passphrase*');
    expect(joined).toContain('--exclude=*/.github-pat*');
  });

  it('excludes the derived bloat dirs from every archiver', () => {
    const joined = readPolicy().excludePatterns.join(' ');
    for (const dir of ['backups', 'cache', 'logs', 'snapshots', 'telemetry', 'site-secrets']) {
      expect(joined).toContain(`--exclude=./${dir}`);
    }
    const fallback = [...FALLBACK_EXCLUDE_NAMES];
    for (const dir of ['backups', 'cache', 'logs', 'snapshots', 'telemetry', 'site-secrets']) {
      expect(fallback).toContain(dir);
    }
  });

  it('does NOT exclude data we must keep: db, wal, shm, derived indexes', () => {
    const joined = readPolicy().excludePatterns.join(' ');
    for (const keep of ['case-index.sqlite', 'embeddings', 'memphis.db', 'chains']) {
      expect(joined).not.toContain(`--exclude=*/${keep}*`);
      expect(joined).not.toContain(`--exclude=./${keep}`);
    }
  });

  it('the CLI tar path and the fallback path use the same source', () => {
    const policy = readPolicy().excludePatterns;
    expect(tarPatternArgs().length).toBe(BACKUP_EXCLUDE_PATTERNS.length);
    // The CLI must expose the exact policy, not a second hand-kept list.
    expect(BACKUP_EXCLUDE_PATTERNS).toEqual(policy);
    expect(BACKUP_EXCLUDE_PATTERNS.length).toBeGreaterThan(0);
  });

  it('the runner consumes the shared policy instead of its own literal list', () => {
    const src = readFileSync(RUNNER, 'utf8');
    expect(src).toContain('backup-exclude-policy.json');
    expect(src).not.toContain("'--exclude=./backups'");
    expect(src).not.toContain("'--exclude=./cache'");
    expect(src).not.toContain("'--exclude=./logs'");
  });

  it('applies the policy on a real tree: sensitive files are skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-policy-'));
    const data = join(root, 'data');
    for (const sub of [
      'chains',
      'chains/journal',
      'chains/.config',
      'site-secrets',
      'telemetry',
      'backups',
      'cache',
      'logs',
      'snapshots',
    ]) {
      mkdirSync(join(data, sub), { recursive: true });
    }
    // Excluded DIRECTORIES are reported at the directory level: the walk
    // never descends, so a file inside one is excluded by its parent, not
    // by name. tar behaves the same way.
    const secrets = [
      'vault-entries.json',
      'vault-state.json',
      'vault-state.json.bak-diag-1',
      'site-secrets',
      'telemetry',
      'backups',
      'cache',
      'logs',
      'snapshots',
    ];
    // Directories are already created above; seed each with a file so the
    // exclusion is meaningful rather than an empty dir.
    for (const rel of ['site-secrets', 'telemetry', 'backups', 'cache', 'logs', 'snapshots']) {
      writeFileSync(join(data, rel, 'inside.txt'), 'SENSITIVE');
    }
    for (const rel of secrets.filter((p) => p.includes('.'))) {
      writeFileSync(join(data, rel), 'SENSITIVE');
    }
    // data we must keep
    const keeps = [
      'chains/journal/000001.json',
      'chains/.config/index.json',
      'case-index.sqlite',
      'case-index.sqlite-wal',
      'case-index.sqlite-shm',
      'memphis.db',
    ];
    for (const rel of keeps) writeFileSync(join(data, rel), 'KEEP');
    writeFileSync(join(data, 'snapshots', 't.tar.gz'), 'BLOAT');

    const out = execFileSync(
      'node',
      [join(process.cwd(), RUNNER), '--data-dir', data, '--dry-run'],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(out);

    expect(result.dryRun).toBe(true);
    for (const excluded of secrets) {
      expect(result.excluded).toContain(`./${excluded}`);
    }
    // The files under an excluded directory must never appear as kept.
    for (const dir of ['site-secrets', 'telemetry', 'backups']) {
      for (const entry of result.excluded) {
        expect(entry.startsWith(`./${dir}/`)).toBe(false);
      }
    }
    for (const kept of keeps) {
      expect(result.excluded).not.toContain(`./${kept}`);
    }
  });

  it('every secret carries a form that matches without a leading path', () => {
    // GNU tar matches `*/name` against a root entry, so the `*/name` glob
    // alone is indistinguishable from correct here — a test run on this host
    // cannot tell the two tar dialects apart. It passed with the `name*`
    // forms deleted, which is the measurement that matters: the invariant is
    // asserted structurally, and the macOS run is what proves the glob is
    // needed. Deleting a `name*` form must fail this.
    const patterns = tarPatternArgs().map((p) => p.replace('--exclude=', ''));
    for (const secret of [
      '.env',
      '.env.*',
      'vault-entries.json*',
      'vault-state.json*',
      '.tier2-passphrase*',
      '.github-pat*',
      'memphis.pid',
      'boot-failures.json*',
      'embed-index.json.tmp-*',
    ]) {
      expect(patterns, `missing a root-level form for ${secret}`).toContain(secret);
    }
  });

  it('tar drops a secret stored at the archive root', () => {
    // The macOS runner put `./vault-state.json` inside the archive. The
    // `*/name` glob needs a directory component in front of the name, so it
    // cannot match a root entry — every secret therefore also carries a
    // bare `name*` form. This runs real tar rather than reading the policy,
    // because the failure was in how tar matched, not in what we declared.
    const root = mkdtempSync(join(tmpdir(), 'memphis-policy-tar-'));
    mkdirSync(join(root, 'chains'), { recursive: true });
    writeFileSync(join(root, 'chains/journal-000001.json'), '{"fixture":true}');
    writeFileSync(join(root, 'vault-state.json'), 'SECRET');
    writeFileSync(join(root, 'vault-entries.json'), 'SECRET');
    writeFileSync(join(root, '.env'), 'SECRET');
    // A file whose name merely contains the secret's suffix must survive.
    writeFileSync(join(root, 'memphis.env'), 'NOT A SECRET');
    // The archive lives outside the tree: writing it into a directory tar is
    // reading makes tar exit 1 with "file changed as we read it", which is a
    // property of the fixture, not of the policy under test.
    const archive = join(tmpdir(), `memphis-policy-tar-${process.pid}-${Date.now()}.tar.gz`);

    execFileSync(
      'tar',
      ['-czf', archive, '--warning=no-file-changed', ...tarPatternArgs(), '-C', root, '.'],
      { stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } },
    );
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });

    expect(listing).toContain('chains/journal-000001.json');
    expect(listing).not.toMatch(/vault-state\.json/);
    expect(listing).not.toMatch(/vault-entries\.json/);
    expect(listing).not.toMatch(/(^|\/)\.env$/m);
    expect(listing).toMatch(/memphis\.env/);
  });
});
