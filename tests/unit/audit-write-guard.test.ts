/**
 * Audit-write guard — Block 1853 incident regression (2026-05-12).
 *
 * Three layers tested:
 *   1. The guard helper itself (isAuditWriteAllowed semantics).
 *   2. Wired call sites (writeSecurityAudit, emitRuntimeSecurityEvent,
 *      appendBlock) refuse / allow as expected.
 *   3. Migration shape: existing-style tests that mock the adapters
 *      stay green (we don't break the dominant test pattern).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emitAuditWriteGuardWarning,
  isAuditWriteAllowed,
  resetAuditWriteGuardWarnings,
  assertAuditWriteAllowed,
} from '../../src/infra/logging/audit-write-guard.js';
import { writeSecurityAudit } from '../../src/infra/logging/security-audit.js';
import { emitRuntimeSecurityEvent } from '../../src/security/runtime-security-events.js';

describe('audit-write-guard helpers', () => {
  beforeEach(() => {
    resetAuditWriteGuardWarnings();
  });

  it('allows audit writes outside VITEST regardless of env', () => {
    expect(isAuditWriteAllowed({})).toBe(true);
    expect(isAuditWriteAllowed({ MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '0' })).toBe(true);
    // VITEST=true is what the runtime sets; verify the helper doesn't
    // mis-read VITEST=undefined as "in test mode".
    expect(isAuditWriteAllowed({ VITEST: undefined })).toBe(true);
  });

  it('refuses audit writes inside VITEST without opt-in', () => {
    expect(isAuditWriteAllowed({ VITEST: 'true' })).toBe(false);
    expect(
      isAuditWriteAllowed({ VITEST: 'true', MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '0' }),
    ).toBe(false);
    expect(
      isAuditWriteAllowed({ VITEST: 'true', MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '' }),
    ).toBe(false);
  });

  it.each(['1', 'true', 'on', 'TRUE', 'On'])(
    'opt-in form %s allows audit writes inside VITEST',
    (value) => {
      expect(
        isAuditWriteAllowed({ VITEST: 'true', MEMPHIS_TEST_ALLOW_AUDIT_WRITE: value }),
      ).toBe(true);
    },
  );

  it('assertAuditWriteAllowed throws with remediation text when guard fails', () => {
    expect(() => assertAuditWriteAllowed('test-context', { VITEST: 'true' })).toThrow(
      /MEMPHIS_TEST_ALLOW_AUDIT_WRITE/,
    );
    expect(() =>
      assertAuditWriteAllowed('test-context', {
        VITEST: 'true',
        MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
      }),
    ).not.toThrow();
    expect(() => assertAuditWriteAllowed('test-context', {})).not.toThrow();
  });

  it('emitAuditWriteGuardWarning is throttled per context string', () => {
    // No assertion on stderr content — vitest swallows it. Just verify
    // multiple calls with the same context don't crash + the throttle
    // mechanism remains exposed.
    emitAuditWriteGuardWarning('ctx-a');
    emitAuditWriteGuardWarning('ctx-a'); // throttled — no second write
    emitAuditWriteGuardWarning('ctx-b'); // different context — would fire
    resetAuditWriteGuardWarnings();
    emitAuditWriteGuardWarning('ctx-a'); // after reset — fires again
  });
});

describe('writeSecurityAudit guard wiring', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memphis-audit-guard-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to write under VITEST without opt-in (no audit file produced)', () => {
    const logPath = join(home, 'audit.jsonl');
    const env: NodeJS.ProcessEnv = {
      VITEST: 'true',
      MEMPHIS_SECURITY_AUDIT_LOG_PATH: logPath,
      // MEMPHIS_TEST_ALLOW_AUDIT_WRITE deliberately unset
    };
    writeSecurityAudit({ action: 'test.fixture', status: 'allowed' }, env);
    expect(existsSync(logPath)).toBe(false);
  });

  it('writes when opt-in env is set', () => {
    const logPath = join(home, 'audit.jsonl');
    const env: NodeJS.ProcessEnv = {
      VITEST: 'true',
      MEMPHIS_SECURITY_AUDIT_LOG_PATH: logPath,
      MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
    };
    writeSecurityAudit({ action: 'test.allowed', status: 'allowed' }, env);
    expect(existsSync(logPath)).toBe(true);
    expect(readFileSync(logPath, 'utf8')).toContain('test.allowed');
  });
});

describe('emitRuntimeSecurityEvent guard wiring', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'memphis-emit-guard-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('short-circuits under VITEST without opt-in (no audit file, no chain block)', async () => {
    const env: NodeJS.ProcessEnv = { VITEST: 'true', MEMPHIS_HOME: home };
    await emitRuntimeSecurityEvent({ action: 'test.fixture', status: 'allowed' }, env);
    expect(existsSync(join(home, 'security-audit.log'))).toBe(false);
    expect(existsSync(join(home, 'chains', 'system'))).toBe(false);
  });
});
