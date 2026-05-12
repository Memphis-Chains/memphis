/**
 * REV2 Temat 1 (2026-05-12) — memphis_glob extra-root allowlist.
 *
 * Background: operator's Telegram session 2026-05-12 22:31-22:46 hit
 * `memphis_glob` returning 'Path outside ~/memphis/' when the agent
 * tried to look for the photo attachment the operator forwarded. Two
 * problems: (a) the temp file was already unlinked before the next
 * turn, (b) even with persistence, glob hard-coded ~/memphis/ as the
 * only allowed root.
 *
 * Fix: persist attachments under `<data>/state/telegram-attachments/`
 * (telegram.ts) AND add that path to the glob extra-roots allowlist
 * so the agent can re-discover the file.
 *
 * This test exercises only the allowlist piece — the persistence side
 * lives in the telegram handler and is verified manually by operator
 * (B-step: send photo, check ~/.memphis/state/telegram-attachments/).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMemphisGlob } from '../../src/mcp/tools/glob.js';

describe('memphis_glob telegram-attachments allowlist', () => {
  let dataDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-attach-'));
    prevDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (prevDataDir !== undefined) process.env.MEMPHIS_DATA_DIR = prevDataDir;
    else delete process.env.MEMPHIS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('allows globbing inside the MEMPHIS_DATA_DIR/state/telegram-attachments/ root', () => {
    const attachDir = path.join(dataDir, 'state', 'telegram-attachments');
    mkdirSync(attachDir, { recursive: true });
    writeFileSync(path.join(attachDir, 'tg-photo-1-2026.jpg'), 'fake-bytes');

    const result = runMemphisGlob({ pattern: 'tg-photo-*.jpg', path: attachDir });
    expect(result.error).toBeUndefined();
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.files[0]).toContain('tg-photo-1-2026.jpg');
  });

  it('rejects paths outside both ~/memphis/ and the allowed extra roots', () => {
    // /tmp is never an allowed root. runMemphisGlob throws AppError
    // from assertInProject (caller is expected to catch — this is the
    // pre-existing contract for the 403 path validation, not changed
    // by this PR).
    const tmpProbe = mkdtempSync(path.join(os.tmpdir(), 'memphis-glob-tmp-probe-'));
    try {
      writeFileSync(path.join(tmpProbe, 'leak.txt'), 'x');
      expect(() => runMemphisGlob({ pattern: '*.txt', path: tmpProbe })).toThrow(
        /outside|allowed/,
      );
    } finally {
      rmSync(tmpProbe, { recursive: true, force: true });
    }
  });
});
