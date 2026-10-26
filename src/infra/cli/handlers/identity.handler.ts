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
 *   - `recover` — restore the public DID from the existing vault seed
 *   - `show`   — print current DID JSON
 */

import { randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';

import type { CommandHandler } from './command-handler.js';
import { getDataDir } from '../../../config/paths.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import {
  listVaultEntryMetadata,
  storeVaultSecret,
  withVaultSecret,
} from '../../../security/vault-boundary.js';
import { writePrivateAtomicFile } from '../../config/private-atomic-file.js';
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
      recover: () => handleIdentityRecover(context),
      show: () => handleIdentityShow(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.show;
    if (!handler) {
      throw new Error(
        `Unknown subcommand: memphis identity ${subcommand}. Try: init | recover | show`,
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
    const value = JSON.parse(raw) as DidFileSchema;
    if (
      value?.schemaVersion !== SCHEMA_VERSION ||
      value.algorithm !== 'ed25519' ||
      !/^[a-f0-9]{64}$/.test(value.publicKeyHex) ||
      value.did !== `did:key:ed25519:${value.publicKeyHex}` ||
      !Number.isFinite(Date.parse(value.createdAt))
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function identityFailure(context: CliContext, reason: string, message: string): boolean {
  print({ ok: false, reason, message }, context.args.json ?? false);
  process.exitCode = 1;
  return true;
}

async function handleIdentityRecover(context: CliContext): Promise<boolean> {
  const directory = getDataDir(process.env);
  const path = resolve(directory, DID_FILE);
  const existing = readDidFile(directory);
  if (existsSync(path) && !existing)
    return identityFailure(
      context,
      'invalid-public-file',
      'Existing DID file is invalid; preserve it before recovery.',
    );
  let publicKeyHex: string;
  try {
    publicKeyHex = withVaultSecret(
      VAULT_KEY,
      { surface: 'cli', command: 'identity recover' },
      (value) => {
        if (!/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('Invalid identity seed');
        const seed = Buffer.from(value, 'hex');
        try {
          return deriveEd25519PublicHex(seed);
        } finally {
          seed.fill(0);
        }
      },
      process.env,
    );
  } catch {
    return identityFailure(
      context,
      'seed-unavailable',
      'Existing identity seed is missing, invalid or unreadable; recovery did not change the identity.',
    );
  }
  const did = `did:key:ed25519:${publicKeyHex}`;
  if (existing && existing.did !== did)
    return identityFailure(
      context,
      'identity-mismatch',
      'Public DID does not match the vault seed; recovery refused to overwrite it.',
    );
  if (existing) {
    print(
      { ok: true, did, recovered: false, alreadyPresent: true, rotated: false },
      context.args.json ?? false,
    );
    return true;
  }
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writePrivateAtomicFile(
      path,
      JSON.stringify(
        {
          schemaVersion: SCHEMA_VERSION,
          did,
          publicKeyHex,
          algorithm: 'ed25519',
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      { exclusive: true },
    );
  } catch {
    return identityFailure(
      context,
      'publication-failed',
      'Could not publish the public DID; recovery did not replace an existing file or change the vault.',
    );
  }
  print(
    { ok: true, did, publicKeyHex, didFile: path, recovered: true, rotated: false },
    context.args.json ?? false,
  );
  return true;
}

async function handleIdentityInit(context: CliContext): Promise<boolean> {
  const { json, force } = context.args as { json?: boolean; force?: boolean };
  const memphisDir = getDataDir(process.env);

  const existing = readDidFile(memphisDir);

  if (!force) {
    if (existsSync(resolve(memphisDir, DID_FILE)) && !existing)
      return identityFailure(
        context,
        'invalid-public-file',
        'Existing DID file is invalid; preserve it before recovery.',
      );
    if (!existing) {
      try {
        if (
          listVaultEntryMetadata(
            { surface: 'cli', command: 'identity init' },
            process.env,
            VAULT_KEY,
          ).length > 0
        )
          return identityFailure(
            context,
            'recovery-required',
            'An identity seed already exists. Run memphis identity recover to restore the public DID.',
          );
      } catch {
        return identityFailure(
          context,
          'vault-unreadable',
          'Could not inspect existing identity metadata; initialization refused.',
        );
      }
    }
  }
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
    console.log(
      `  Seed:       ${chalk.gray('vault entry ' + VAULT_KEY)} (never written to plaintext)`,
    );
    console.log(
      `  Journal:    ${journaledOk ? chalk.green('config-change recorded') : chalk.yellow('not recorded (vault write succeeded)')}`,
    );
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
      message:
        'No DID found. Use `memphis identity recover` for an existing vault seed, or `memphis identity init` for a new identity.',
    };
    if (!json) {
      console.log(chalk.red('\n  ✗ No DID configured.\n'));
      console.log(
        chalk.gray(
          '  Use `memphis identity recover` for an existing seed, or `memphis identity init` for a new identity.\n',
        ),
      );
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
