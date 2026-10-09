/**
 * Shared-secret endpoints must not ship a default credential.
 *
 * WHY THIS CONTRACT EXISTS
 * ------------------------
 * `api/stats.php` and `api/cron-cleanup.php` both authenticated with a shared
 * secret. Both did it the same way:
 *
 *     $token = getenv('MEMPHIS_STATS_TOKEN');
 *     if (!is_string($token) || $token === '') {
 *         $token = 'memphis-local-stats-2026';   // ← in the repo, in public git
 *     }
 *
 * A key committed to the repository is not a fallback. It is a credential
 * published to everyone who can read the code, and it keeps working after
 * every other rotation. Verified against production before the fix: that
 * string returned HTTP 200 with real visitor, download and funnel numbers.
 *
 * `cron-cleanup.php` was the worse half — the same string unlocked a script
 * that runs `DELETE FROM visitors, events, downloads`.
 *
 * So the rule is narrow and mechanical: a value read from the environment may
 * not fall back to a literal. Unconfigured means the endpoint is closed (503),
 * not open.
 *
 * WHY THIS IS STATIC, NOT EXECUTED
 * --------------------------------
 * CI has no PHP. A shell test running `php -l` would report "0 tests" — silently
 * passing — on any host without the interpreter. Reading the source is what CI
 * can actually do; the runtime behaviour is proven on the server instead, where
 * the three statuses (503 / 401 / 200) are measured over HTTP.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const API = resolve('sites/memphis-v5/api');
const BOOT = resolve(API, '_boot.php');

/** Every endpoint that authenticates with the shared secret. */
const SECRET_ENDPOINTS = ['stats.php', 'cron-cleanup.php'] as const;

const read = (f: string): string => readFileSync(resolve(API, f), 'utf8');

/**
 * Does this quoted value look like a CREDENTIAL, or like a name?
 *
 * The first version filtered on `/token/i` alone and flagged
 * `MEMPHIS_STATS_TOKEN` and `HTTP_X_CRON_TOKEN` — environment-variable and
 * header NAMES. Those are not secrets; they are the identifiers the helper is
 * supposed to use. A scan that cannot tell a name from a value reports noise
 * on correct code, and a gate that cries wolf is a gate nobody reads.
 *
 * So a credential is a value that looks random AND is not a declared name.
 */
function isCredentialShaped(v: string): boolean {
  // Declared identifiers: env vars, HTTP headers, our own prefixes.
  if (/^(MEMPHIS_|HTTP_|X_|RUST_|NODE_|GITHUB_)/.test(v)) return false;
  // SHOUTING_SNAKE is a constant or a variable name, not a secret value.
  if (/^[A-Z0-9_]+$/.test(v) && v.includes('_')) return false;
  return /secret|token|pass|key|admin|memphis-local|stats-20/i.test(v);
}

describe('api/_boot.php — require_token has no default credential', () => {
  const boot = readFileSync(BOOT, 'utf8');

  it('defines exactly one require_token helper', () => {
    expect(boot.match(/function require_token\(/g)).toHaveLength(1);
  });

  it('reads the secret from the environment and nothing else', () => {
    // Slice to the helper body: _boot.php legitimately mentions other env vars,
    // so a whole-file `toContain` would pass on an unrelated line.
    const start = boot.indexOf('function require_token(');
    expect(start).toBeGreaterThan(-1);
    const end = boot.indexOf('\nfunction ', start + 1);
    const body = boot.slice(start, end === -1 ? undefined : end);

    expect(body).toContain("getenv('MEMPHIS_STATS_TOKEN')");
    // A missing variable must disable the endpoint, never authenticate anyone.
    expect(body).toContain('endpoint_disabled');
    expect(body).toContain('503');
    expect(body).toContain('hash_equals');
  });

  it('assigns no literal to the expected token', () => {
    const start = boot.indexOf('function require_token(');
    const end = boot.indexOf('\nfunction ', start + 1);
    const body = boot.slice(start, end === -1 ? undefined : end);

    // Anchor to the start of a line. An earlier version used /\$expected\s*=\s*([^;]+);/
    // and matched `!is_string($expected) || $expected === ''` inside the guard —
    // a comparison in a condition, not an assignment. The test then reported a
    // correct implementation as broken, which is worse than no test: the fix is
    // to weaken it back to green.
    const assignments = [...body.matchAll(/^\s*\$expected\s*=\s*(.+);\s*$/gm)].map((m) =>
      (m[1] as string).trim(),
    );
    expect(assignments.length).toBeGreaterThan(0);
    for (const a of assignments) {
      expect(a).toMatch(/^getenv\(/);
      expect(a).not.toMatch(/['"][^'"]+['"]$/);
    }
  });
});

describe('api endpoints — no fall back to a shipped literal', () => {
  it.each(SECRET_ENDPOINTS)('%s delegates to require_token()', (file) => {
    const src = read(file);
    expect(src).toContain('require_token(');
    // The old shape must be gone, not merely complemented.
    expect(src).not.toMatch(/getenv\('MEMPHIS_STATS_TOKEN'\)/);
    expect(src).not.toMatch(/hash_equals/);
  });

  it.each(SECRET_ENDPOINTS)('%s carries no literal token of its own', (file) => {
    const src = read(file);
    // A token-shaped assignment to a quoted literal: $token/$secret/$key = '...'
    const literalToken = /\$(?:token|secret|key|pass(?:word)?)\s*=\s*['"][^'"]{4,}['"]\s*;/;
    expect(literalToken.test(src)).toBe(false);
  });
});

describe('api/ — no credential literal anywhere in the tree', () => {
  const files = [
    '_boot.php',
    'collect.php',
    'cron-cleanup.php',
    'download.php',
    'health.php',
    'lead.php',
    'stats.php',
  ];

  it.each(files)('%s has no quoted secret-like literal', (file) => {
    const src = read(file);
    const found = [...src.matchAll(/['"]([A-Za-z0-9_-]{8,})['"]/g)]
      .map((m) => m[1] as string)
      .filter(isCredentialShaped);
    expect(found).toEqual([]);
  });
});
