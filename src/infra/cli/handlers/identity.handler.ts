/**
 * `memphis identity` CLI — generate + show the operator's DID.
 *
 * Sprint η.1 closes the `t4-did` doctor required-warn. Doctor checks
 * for `~/.memphis/did.json`; if absent, the tier-4 trust check warns
 * "missing DID identity file". Without an actual identity flow, the
 * warn lingers forever. This handler creates one.
 *
 * Format follows the existing kartograf checkpoint convention
 * (`did:key:ed25519:<64-hex>`) for consistency — switching to W3C
 * did:key multibase later is a separate migration. Public part lives
 * in `~/.memphis/did.json`. The 32-byte seed lands in the operator
 * vault under `did_seed` so signing operations can pull it without
 * reading a plaintext key file from disk.
 *
 * Subcommands:
 *   - `init`   — generate fresh keypair (no-op if already present
 *                unless `--force`)
 *   - `show`   — print current DID JSON
 */

import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';

import type { CommandHandler } from './command-handler.js';
import { getDataDir } from '../../../config/paths.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { storeVaultSecret } from '../../../security/vault-boundary.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const DID_FILE = 'did.json';
const VAULT_KEY = 'did_seed';
const SCHEMA_VERSION = 1;

interface DidFileSchema {
  schemaVersion: number;
  did: string;
  publicKeyHex: string;
  algorithm: 'ed25519';
  createdAt: string;
}

export const identityCommandHandler: CommandHandler = {
  name: 'identity',
  commands: ['identity'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'identity';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      init: () => handleIdentityInit(context),
      show: () => handleIdentityShow(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.show;
    if (!handler) {
      throw new Error(
        `Unknown subcommand: memphis identity ${subcommand}. Try: init | show`,
      );
    }
    return handler();
  },
};

/**
 * Derive the 32-byte raw public key from a 32-byte ed25519 seed using
 * node:crypto's PKCS#8 import path. Mirrors the helper in
 * `src/kartograf/checkpoint.ts` so the on-disk DID format stays
 * compatible with checkpoint signing/verification.
 */
function deriveEd25519PublicHex(seed: Buffer): string {
  if (seed.length !== 32) {
    throw new Error(`expected 32-byte ed25519 seed, got ${seed.length}`);
  }
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const privateKey = createPrivateKey({
    key: Buffer.concat([pkcs8Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey);
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI for Ed25519: 12-byte prefix + 32-byte raw key.
  return Buffer.from(spki.slice(-32)).toString('hex');
}

function readDidFile(memphisDir: string): DidFileSchema | undefined {
  const path = resolve(memphisDir, DID_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as DidFileSchema;
  } catch {
    return undefined;
  }
}

async function handleIdentityInit(context: CliContext): Promise<boolean> {
  const { json, force } = context.args as { json?: boolean; force?: boolean };
  const memphisDir = getDataDir(process.env);

  const existing = readDidFile(memphisDir);
  if (existing && !force) {
    const result = {
      ok: false,
      reason: 'already-initialized',
      did: existing.did,
      message:
        'DID already exists at ~/.memphis/did.json. Re-run with --force to rotate (will INVALIDATE any existing signatures).',
    };
    if (!json) {
      console.log(chalk.yellow('\n  ⚠ DID already initialised:\n'));
      console.log(`    ${chalk.cyan(existing.did)}`);
      console.log(chalk.gray('\n    Re-run with --force to rotate.\n'));
    }
    print(result, json ?? false);
    return true;
  }

  // Generate fresh ed25519 seed
  const seed = randomBytes(32);
  const publicKeyHex = deriveEd25519PublicHex(seed);
  const did = `did:key:ed25519:${publicKeyHex}`;

  // Store the seed in vault — it's the signing key and never goes to
  // a plaintext file. Vault encrypts at rest with the operator pepper.
  storeVaultSecret(
    VAULT_KEY,
    seed.toString('hex'),
    { surface: 'cli', command: 'identity init' },
    process.env,
  );

  // Write the public side to ~/.memphis/did.json.
  if (!existsSync(memphisDir)) {
    mkdirSync(memphisDir, { recursive: true });
  }
  const didFile: DidFileSchema = {
    schemaVersion: SCHEMA_VERSION,
    did,
    publicKeyHex,
    algorithm: 'ed25519',
    createdAt: new Date().toISOString(),
  };
  const didPath = resolve(memphisDir, DID_FILE);
  writeFileSync(didPath, JSON.stringify(didFile, null, 2) + '\n', 'utf8');
  // Public key file but lock down to operator-only just in case.
  try {
    chmodSync(didPath, 0o600);
  } catch {
    // chmod failure is non-fatal — file is in operator's home dir.
  }

  // Journal the rotation/init so the bot's chain_hits picks up
  // "operator just rotated DID" the next time identity questions
  // come up.
  let journaledOk = false;
  try {
    const j = await runMemphisJournal({
      content: `Operator initialised Memphis DID: ${did}`,
      tags: ['config-change', 'identity', 'did-init'],
      surface: 'cli',
    });
    journaledOk = j.success;
  } catch {
    // Non-fatal
  }

  const result = {
    ok: true,
    did,
    publicKeyHex,
    didFile: didPath,
    vaultKey: VAULT_KEY,
    journaled: journaledOk,
    rotated: Boolean(existing),
  };

  if (!json) {
    console.log(chalk.green.bold('\n✓ DID identity initialised\n'));
    console.log(`  DID:        ${chalk.cyan(did)}`);
    console.log(`  Public:     ${chalk.gray(publicKeyHex)}`);
    console.log(`  File:       ${chalk.gray(didPath)} (chmod 600)`);
    console.log(`  Seed:       ${chalk.gray('vault entry ' + VAULT_KEY)} (never written to plaintext)`);
    console.log(`  Journal:    ${journaledOk ? chalk.green('config-change recorded') : chalk.yellow('not recorded (vault write succeeded)')}`);
    if (existing) {
      console.log(chalk.yellow.bold('\n  ⚠ Previous DID rotated. Old signatures will not verify.'));
    }
    console.log(chalk.gray('\n  Verify: `memphis doctor` should now show t4-did PASS.\n'));
  }

  print(result, json ?? false);
  return true;
}

async function handleIdentityShow(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const memphisDir = getDataDir(process.env);
  const existing = readDidFile(memphisDir);

  if (!existing) {
    const result = {
      ok: false,
      reason: 'not-initialised',
      message: 'No DID found. Run `memphis identity init` to generate one.',
    };
    if (!json) {
      console.log(chalk.red('\n  ✗ No DID configured.\n'));
      console.log(chalk.gray('  Run `memphis identity init` to generate one.\n'));
    }
    print(result, json ?? false);
    return true;
  }

  if (!json) {
    console.log(chalk.bold('\n  Memphis DID\n'));
    console.log(`  DID:        ${chalk.cyan(existing.did)}`);
    console.log(`  Algorithm:  ${chalk.gray(existing.algorithm)}`);
    console.log(`  Created:    ${chalk.gray(existing.createdAt)}`);
    console.log(`  File:       ${chalk.gray(resolve(memphisDir, DID_FILE))}`);
    console.log('');
  }

  print(existing, json ?? false);
  return true;
}
