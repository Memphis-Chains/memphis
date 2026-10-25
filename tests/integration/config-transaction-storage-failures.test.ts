import { spawnSync } from 'node:child_process';
import { createCipheriv, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({
  target: '',
  armed: false,
  hits: 0,
  descriptors: new Set<number>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      if (fault.armed && String(args[0]).startsWith(`${fault.target}.tmp-`))
        fault.descriptors.add(fd);
      return fd;
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.armed && typeof args[0] === 'number' && fault.descriptors.has(args[0])) {
        fault.hits++;
        // Model an exhausted filesystem after a partial temporary write.
        actual.writeFileSync(args[0], String(args[1]).slice(0, 17), 'utf8');
        throw Object.assign(new Error('Synthetic storage capacity exhausted'), { code: 'ENOSPC' });
      }
      return actual.writeFileSync(...args);
    },
    closeSync: (fd: number) => {
      fault.descriptors.delete(fd);
      actual.closeSync(fd);
    },
  };
});

import {
  commitConfigurationTransaction,
  configurationFileHash,
} from '../../src/infra/config/config-transaction.js';
import { createIsolatedTestRuntime } from '../helpers/isolated-runtime.js';

const roots: string[] = [];
const restricted: string[] = [];
afterEach(() => {
  fault.armed = false;
  fault.target = '';
  fault.hits = 0;
  fault.descriptors.clear();
  restricted.splice(0).forEach((p) => chmodSync(p, 0o700));
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});

const OLD_PEPPER = 'synthetic-storage-failure-original-pepper';
const NEW_PEPPER = 'synthetic-storage-failure-replacement-pepper';
const PLAINTEXT = 'synthetic-storage-failure-credential';
function encrypt(key: Buffer, plaintext: Buffer) {
  const iv = Buffer.alloc(12, 9);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    encrypted: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}
function state(master: Buffer, pepper: string) {
  const kek = scryptSync(pepper, 'memphis-vault-state-v2', 32, { N: 16384, r: 8, p: 1 });
  try {
    const sealed = encrypt(kek, master);
    return JSON.stringify({
      version: 2,
      salt: Buffer.alloc(32, 1).toString('base64'),
      iv: sealed.iv,
      encryptedMasterKey: sealed.encrypted,
      tag: sealed.tag,
    });
  } finally {
    kek.fill(0);
  }
}
function entries(master: Buffer) {
  return JSON.stringify([{ key: 'first', ...encrypt(master, Buffer.from(PLAINTEXT)) }]);
}

const recoveryProbe = `
import { readFileSync } from 'node:fs';
import { createDecipheriv, scryptSync } from 'node:crypto';
import { parse } from 'dotenv';
import { recoverConfigurationTransaction } from './src/infra/config/config-transaction.ts';
try {
 const [journal, statePath, envPath, entriesPath, expectedRecovery] = process.argv.slice(1);
 const recovered = recoverConfigurationTransaction(journal);
 if (recovered !== (expectedRecovery === 'yes')) throw Error();
 const pepper = parse(readFileSync(envPath)).MEMPHIS_VAULT_PEPPER;
 const state = JSON.parse(readFileSync(statePath,'utf8'));
 const kek = scryptSync(pepper,'memphis-vault-state-v2',32,{N:16384,r:8,p:1});
 function decrypt(key, iv, ciphertext, tag) {
  const decipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  decipher.setAuthTag(Buffer.from(tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]);
 }
 const master = decrypt(kek,state.iv,state.encryptedMasterKey,state.tag);
 const entry = JSON.parse(readFileSync(entriesPath,'utf8'))[0];
 const plaintext = decrypt(master,entry.iv,entry.encrypted,entry.tag);
 if (plaintext.toString('utf8') !== 'synthetic-storage-failure-credential') throw Error();
 plaintext.fill(0);master.fill(0);kek.fill(0);
 console.log('STORAGE_RECOVERY_OK');
} catch { console.error('Isolated recovery probe failed');process.exitCode=1; }
`;

describe('encrypted configuration recovery after storage publication failure', () => {
  for (const operation of ['pepper', 'master-key'] as const) {
    for (const failure of ['ENOSPC', 'EACCES'] as const) {
      it
        .skipIf(failure === 'EACCES' && (process.platform === 'win32' || process.getuid?.() === 0))
        .each([0, 1])(
        `${operation}: ${failure} publishing target %s recovers twice`,
        (index) => {
          const f = createIsolatedTestRuntime(process.env, resolve('.'));
          roots.push(f.root);
          const firstDir = join(f.root, 'first-target');
          const secondDir = join(f.root, 'second-target');
          mkdirSync(firstDir);
          mkdirSync(secondDir);
          const statePath = join(firstDir, 'vault-state.json');
          const envPath = join(secondDir, '.env');
          const entriesPath = join(secondDir, 'vault-entries.json');
          const journal = join(f.root, 'transaction-control');
          const didPath = join(f.root, 'did.json');
          const oldMaster = Buffer.alloc(32, 2);
          const newMaster = operation === 'master-key' ? Buffer.alloc(32, 3) : oldMaster;
          writeFileSync(statePath, state(oldMaster, OLD_PEPPER), { mode: 0o600 });
          writeFileSync(envPath, `MEMPHIS_VAULT_PEPPER=${OLD_PEPPER}\n`, { mode: 0o600 });
          writeFileSync(entriesPath, entries(oldMaster), { mode: 0o600 });
          writeFileSync(
            didPath,
            JSON.stringify({ did: 'did:memphis:synthetic-preserved-identity' }),
          );
          const originalEntries = readFileSync(entriesPath);
          const originalDid = readFileSync(didPath);
          const second = operation === 'pepper' ? envPath : entriesPath;
          const updates = [
            {
              path: statePath,
              content: state(newMaster, operation === 'pepper' ? NEW_PEPPER : OLD_PEPPER),
              expectedHash: configurationFileHash(statePath),
            },
            {
              path: second,
              content:
                operation === 'pepper'
                  ? `MEMPHIS_VAULT_PEPPER=${NEW_PEPPER}\n`
                  : entries(newMaster),
              expectedHash: configurationFileHash(second),
            },
          ];
          const before = updates.map((u) => readFileSync(u.path));
          if (failure === 'ENOSPC') {
            fault.target = updates[index].path;
            fault.armed = true;
          } else {
            const directory = index === 0 ? firstDir : secondDir;
            chmodSync(directory, 0o500);
            restricted.push(directory);
          }
          try {
            expect(() => commitConfigurationTransaction(journal, updates)).toThrow(
              expect.objectContaining({ code: failure }),
            );
            if (failure === 'ENOSPC') expect(fault.hits).toBe(1);
            expect(readFileSync(updates[index].path)).toEqual(before[index]);
            if (index === 0) expect(readFileSync(second)).toEqual(before[1]);
            else expect(readFileSync(statePath, 'utf8')).toBe(updates[0].content);
            expect(
              readdirSync(index === 0 ? firstDir : secondDir).some((n) => n.includes('.tmp-')),
            ).toBe(false);
          } finally {
            fault.armed = false;
            restricted.splice(0).forEach((p) => chmodSync(p, 0o700));
            oldMaster.fill(0);
            newMaster.fill(0);
          }
          for (const expectedRecovery of ['yes', 'no']) {
            const child = spawnSync(
              process.execPath,
              [
                '--import',
                'tsx',
                '--input-type=module',
                '-e',
                recoveryProbe,
                journal,
                statePath,
                envPath,
                entriesPath,
                expectedRecovery,
              ],
              { cwd: resolve('.'), env: f.env, encoding: 'utf8', timeout: 30000 },
            );
            expect(child.status, child.stderr).toBe(0);
            expect(child.stdout.trim()).toBe('STORAGE_RECOVERY_OK');
            expect(child.stdout + child.stderr).not.toContain(PLAINTEXT);
            expect(child.stdout + child.stderr).not.toContain(OLD_PEPPER);
            expect(child.stdout + child.stderr).not.toContain(NEW_PEPPER);
          }
          expect(readFileSync(didPath)).toEqual(originalDid);
          if (operation === 'pepper') expect(readFileSync(entriesPath)).toEqual(originalEntries);
          else expect(readFileSync(entriesPath)).not.toEqual(originalEntries);
          expect(readFileSync(statePath, 'utf8')).toBe(updates[0].content);
          expect(readFileSync(second, 'utf8')).toBe(updates[1].content);
        },
        60000,
      );
    }
  }
});
