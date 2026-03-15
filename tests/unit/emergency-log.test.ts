import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveEmergencyLogPath,
  writeEmergencyLog,
} from '../../src/infra/runtime/emergency-log.js';

describe('emergency log resolver', () => {
  const originals = {
    HOME: process.env.HOME,
  };

  afterEach(() => {
    if (originals.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = originals.HOME;
  });

  it('falls back to next writable candidate when primary path is blocked', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-emergency-log-'));
    const notDir = join(root, 'not-dir');
    writeFileSync(notDir, 'x', 'utf8');
    const primary = join(notDir, 'emergency.log');
    const fallback = join(root, 'ok', 'emergency.log');

    const out = writeEmergencyLog('security event', process.env, {
      explicitPaths: [primary, fallback],
      includeCwdFallback: false,
    });

    expect(out).not.toBeNull();
    expect(out?.path).toBe(fallback);
    expect(out?.fallbackPathUsed).toBe(true);
    expect(readFileSync(fallback, 'utf8')).toContain('security event');
  });

  it('returns null when no candidate is writable', () => {
    const root = mkdtempSync(join(tmpdir(), 'memphis-emergency-none-'));
    const notDirA = join(root, 'not-dir-a');
    const notDirB = join(root, 'not-dir-b');
    writeFileSync(notDirA, 'x', 'utf8');
    writeFileSync(notDirB, 'y', 'utf8');

    const out = resolveEmergencyLogPath(process.env, {
      explicitPaths: [join(notDirA, 'a.log'), join(notDirB, 'b.log')],
      includeCwdFallback: false,
    });
    expect(out).toBeNull();
  });
});
