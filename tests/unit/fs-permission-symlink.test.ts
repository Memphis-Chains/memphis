import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertFsPermission,
  isInsideMemphisSandbox,
  isTier3FsBypassActive,
} from '../../src/mcp/tools/fs-permission.js';

/**
 * Regression net for Codex P1 against PR #76: the fs sandbox check only
 * called `path.normalize`, so a symlink at ~/memphis/link -> /etc let a
 * caller escape the sandbox. The fix resolves symlinks via `realpathSync`
 * (walking up to the nearest existing ancestor for create-new paths).
 *
 * Also covers the second PR #77 P1: `isTier3FsBypassActive` used to fall
 * back to the process-wide `hasAnyActiveTier3Session`, so one surface's
 * tier-3 elevation leaked fs-mutation rights to every other surface. The
 * fix now reads ONLY the per-request env override.
 */

interface TestEnv {
  tmpHome: string;
  sandboxDir: string;
  origHome: string | undefined;
}

function setup(): TestEnv {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'memphis-fs-perm-'));
  const sandboxDir = path.join(tmpHome, 'memphis');
  mkdirSync(sandboxDir, { recursive: true });
  const origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  return { tmpHome, sandboxDir, origHome };
}

function tearDown(env: TestEnv): void {
  if (env.origHome === undefined) delete process.env.HOME;
  else process.env.HOME = env.origHome;
  rmSync(env.tmpHome, { recursive: true, force: true });
}

describe('fs-permission — symlink escape protection (Codex P1)', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('flags a symlink inside ~/memphis that points at /etc as OUTSIDE sandbox', () => {
    // /etc should exist in every real environment. On a CI host where it
    // doesn't, the realpath call falls back; this test still exercises the
    // intent — a symlink inside the sandbox whose target is outside must be
    // rejected regardless.
    const linkPath = path.join(env.sandboxDir, 'escape');
    symlinkSync('/etc', linkPath);
    // The symlink itself is inside the sandbox, but its realpath target
    // (/etc) is not. isInsideMemphisSandbox must return false for the link.
    expect(isInsideMemphisSandbox(linkPath)).toBe(false);
  });

  it('flags a symlink inside ~/memphis pointing at /tmp as OUTSIDE sandbox', () => {
    const otherDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-escape-target-'));
    try {
      const linkPath = path.join(env.sandboxDir, 'esc-link');
      symlinkSync(otherDir, linkPath);
      expect(isInsideMemphisSandbox(linkPath)).toBe(false);

      // And descending through the symlink — should still be outside.
      const childThroughLink = path.join(linkPath, 'child.txt');
      expect(isInsideMemphisSandbox(childThroughLink)).toBe(false);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('accepts a regular file inside ~/memphis', () => {
    const filePath = path.join(env.sandboxDir, 'legit.txt');
    writeFileSync(filePath, 'ok', 'utf8');
    expect(isInsideMemphisSandbox(filePath)).toBe(true);
  });

  it('accepts a not-yet-existing path inside ~/memphis (create-new)', () => {
    const filePath = path.join(env.sandboxDir, 'new.txt');
    expect(isInsideMemphisSandbox(filePath)).toBe(true);
  });

  it('refuses delete on a symlink-escape path even without tier-3', () => {
    const linkPath = path.join(env.sandboxDir, 'danger');
    const outside = mkdtempSync(path.join(os.tmpdir(), 'memphis-escape-'));
    try {
      const innerFile = path.join(outside, 'payload.txt');
      writeFileSync(innerFile, 'sensitive', 'utf8');
      symlinkSync(outside, linkPath);
      // Delete on inner-file via the link: must trip the outside-sandbox
      // gate (no tier-3 in this env), even though the path starts with
      // ~/memphis.
      expect(() =>
        assertFsPermission(path.join(linkPath, 'payload.txt'), {
          operation: 'delete',
          tier3Active: false,
        }),
      ).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('fs-permission — tier-3 bypass is per-request only (Codex P1)', () => {
  it('returns true only when the request env has the explicit override', () => {
    expect(
      isTier3FsBypassActive({
        MEMPHIS_TIER3_FS_UNRESTRICTED: 'true',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('returns false without the env override (no process-wide fallback)', () => {
    // Even if the test harness had ambient tier-3 sessions, the fs bypass
    // must not light up without the per-request env override.
    expect(isTier3FsBypassActive({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('case-insensitive on the env value', () => {
    expect(
      isTier3FsBypassActive({
        MEMPHIS_TIER3_FS_UNRESTRICTED: 'TRUE',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it('rejects non-"true" values', () => {
    for (const value of ['false', '1', 'yes', 'on', '']) {
      expect(
        isTier3FsBypassActive({
          MEMPHIS_TIER3_FS_UNRESTRICTED: value,
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });
});
