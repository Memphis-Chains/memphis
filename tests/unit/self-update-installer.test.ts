import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installUpdate,
  rollbackUpdate,
  type InstallStateFile,
} from '../../src/infra/self-update/installer.js';

const SAMPLE_RELEASE = {
  tag: 'v2.0.0',
  name: 'v2.0.0',
  publishedAt: '2026-04-14T00:00:00Z',
  tarballUrl:
    'https://github.com/Memphis-Chains/memphis/releases/download/v2.0.0/memphis-2.0.0.tar.gz',
};

describe('installUpdate (closes deferred item #1)', () => {
  let installRoot: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), 'memphis-selfupdate-'));
    process.env.MEMPHIS_SELF_UPDATE_ROOT = installRoot;
    process.env.MEMPHIS_SELF_UPDATE_SKIP_SIG = 'true'; // bypass sig in tests
  });

  afterEach(() => {
    rmSync(installRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns up-to-date when check reports no update', async () => {
    const outcome = await installUpdate({
      currentVersion: '2.0.0',
      checkFn: async () => ({
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        updateAvailable: false,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.skipped).toBe('up-to-date');
  });

  it('reports no-release when check fails', async () => {
    const outcome = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: null,
        updateAvailable: false,
        error: 'github responded 503',
        checkedAt: new Date().toISOString(),
      }),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.skipped).toBe('no-release');
  });

  it('happy path: download → verify (skipped) → extract → swap symlink → update state', async () => {
    const fetched: string[] = [];
    const extracted: Array<{ tarball: string; dest: string }> = [];
    const verifyCalls: number[] = [];

    const outcome = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
      fetchFn: async (url, destPath) => {
        fetched.push(url);
        writeFileSync(destPath, 'fake-tarball-bytes');
      },
      verifyFn: async () => {
        verifyCalls.push(1);
      },
      extractFn: async (tarball, dest) => {
        extracted.push({ tarball, dest });
        await fs.mkdir(dest, { recursive: true });
        await fs.writeFile(join(dest, 'package.json'), '{"version":"2.0.0"}');
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.toVersion).toBe('2.0.0');
    expect(outcome.installPath).toMatch(/versions\/v2\.0\.0$/);
    // Downloaded tarball + tried to download .sig (.sig download is best-effort)
    expect(fetched.filter((u) => u.endsWith('.tar.gz')).length).toBe(1);
    expect(verifyCalls.length).toBe(1);
    expect(extracted.length).toBe(1);

    // Symlink points at the new version
    const symlinkTarget = await fs.readlink(join(installRoot, 'current'));
    expect(symlinkTarget).toBe(outcome.installPath);

    // State file recorded the transition
    const state = JSON.parse(
      await fs.readFile(join(installRoot, 'install-state.json'), 'utf8'),
    ) as InstallStateFile;
    expect(state.current?.version).toBe('v2.0.0');
    expect(state.previous).toBeNull();
    expect(state.history).toHaveLength(1);
  });

  it('reports failedStage when extract blows up', async () => {
    const outcome = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
      fetchFn: async (_url, destPath) => {
        writeFileSync(destPath, 'fake');
      },
      verifyFn: async () => {},
      extractFn: async () => {
        throw new Error('tar: malformed tarball');
      },
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStage).toBe('extract');
    expect(outcome.error).toMatch(/malformed tarball/);
  });

  it('reports failedStage when signature verify fails', async () => {
    const outcome = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
      fetchFn: async (_url, destPath) => {
        writeFileSync(destPath, 'fake');
      },
      verifyFn: async () => {
        throw new Error('signature verification failed: bad signature');
      },
      extractFn: async () => {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStage).toBe('verify-signature');
  });

  it('install then rollback returns to previous version', async () => {
    // Seed install-state with an existing v1.0.0 in place
    const v1Path = join(installRoot, 'versions', 'v1.0.0');
    await fs.mkdir(v1Path, { recursive: true });
    const v1State: InstallStateFile = {
      current: { version: 'v1.0.0', path: v1Path, installedAt: '2026-04-01T00:00:00Z' },
      previous: null,
      history: [{ version: 'v1.0.0', installedAt: '2026-04-01T00:00:00Z' }],
    };
    await fs.writeFile(join(installRoot, 'install-state.json'), JSON.stringify(v1State), 'utf8');
    await fs.symlink(v1Path, join(installRoot, 'current'));

    // Install v2.0.0
    const install = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
      fetchFn: async (_url, destPath) => {
        writeFileSync(destPath, 'fake');
      },
      verifyFn: async () => {},
      extractFn: async (_tb, dest) => {
        await fs.mkdir(dest, { recursive: true });
      },
    });
    expect(install.ok).toBe(true);

    // Now roll back
    const rollback = await rollbackUpdate();
    expect(rollback.ok).toBe(true);
    expect(rollback.fromVersion).toBe('v2.0.0');
    expect(rollback.toVersion).toBe('v1.0.0');

    // Symlink points back at v1
    const symlinkTarget = await fs.readlink(join(installRoot, 'current'));
    expect(symlinkTarget).toBe(v1Path);
  });

  it('rollback refuses when no previous version is recorded', async () => {
    const state: InstallStateFile = {
      current: {
        version: 'v1.0.0',
        path: join(installRoot, 'versions', 'v1.0.0'),
        installedAt: '2026-04-01T00:00:00Z',
      },
      previous: null,
      history: [],
    };
    await fs.writeFile(join(installRoot, 'install-state.json'), JSON.stringify(state), 'utf8');

    const outcome = await rollbackUpdate();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/no previous version/);
  });

  it('rollback refuses when the previous version directory is missing', async () => {
    const state: InstallStateFile = {
      current: {
        version: 'v2.0.0',
        path: '/nonexistent/v2.0.0',
        installedAt: '2026-04-01T00:00:00Z',
      },
      previous: {
        version: 'v1.0.0',
        path: '/nonexistent/v1.0.0',
        installedAt: '2026-03-01T00:00:00Z',
      },
      history: [],
    };
    await fs.writeFile(join(installRoot, 'install-state.json'), JSON.stringify(state), 'utf8');

    const outcome = await rollbackUpdate();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/previous version directory is missing/);
  });

  it('sig-verify default path refuses when MEMPHIS_SELF_UPDATE_PUBKEY_PATH not set and skip flag absent', async () => {
    delete process.env.MEMPHIS_SELF_UPDATE_SKIP_SIG;
    delete process.env.MEMPHIS_SELF_UPDATE_PUBKEY_PATH;

    const outcome = await installUpdate({
      currentVersion: '1.0.0',
      checkFn: async () => ({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
        release: SAMPLE_RELEASE,
        checkedAt: new Date().toISOString(),
      }),
      fetchFn: async (_url, destPath) => {
        writeFileSync(destPath, 'fake');
      },
      extractFn: async () => {},
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failedStage).toBe('verify-signature');
    expect(outcome.error).toMatch(/MEMPHIS_SELF_UPDATE_PUBKEY_PATH/);
  });
});
