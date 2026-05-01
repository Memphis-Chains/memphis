import {
  listVaultEntryMetadata,
  readVaultSecretByKey,
  storeVaultSecret,
} from '../../../security/vault-boundary.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

export const secretCommandHandler: CommandHandler = {
  name: 'secret',
  commands: ['secret'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'secret';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    // S5-1: gate add/get/list before any vault touch. Aligns with
    // GATED_OPERATIONS in operator-gate.ts. Prior to this sweep, the
    // registry promised a passphrase prompt but the handler ran the
    // op silently — a local-host adversary could read or write secret
    // values without the operator passphrase.
    const gatedSubs = new Set(['add', 'get', 'list']);
    if (subcommand && gatedSubs.has(subcommand)) {
      if (!(await requireOperatorAuth())) {
        throw new Error('Operator authentication failed.');
      }
    }
    const handlers: Record<string, () => Promise<boolean>> = {
      add: async () => handleSecretAdd(context),
      get: async () => handleSecretGet(context),
      list: async () => handleSecretList(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.list;
    if (!handler) {
      console.error(`Unknown secret subcommand: ${String(subcommand)}`);
      console.error('Usage: memphis secret <add|get|list>');
      console.error('  add  --key <name> --value <plaintext>   Store an encrypted secret');
      console.error('  get  --key <name>                       Retrieve and decrypt a secret');
      console.error('  list [--key <name>]                     List stored secrets');
      return true;
    }
    // Fall-through to default `list` (no subcommand) also requires auth.
    if (!subcommand && !(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }
    return handler();
  },
};

function handleSecretAdd(context: CliContext): boolean {
  const { json, key, value } = context.args;
  if (!key || value === undefined) {
    throw new Error('secret add requires --key <name> and --value <plaintext>');
  }

  try {
    const stored = storeVaultSecret(
      key,
      value,
      { surface: 'cli', command: 'secret add' },
      process.env,
    );
    print({ ok: true, key, fingerprint: stored.fingerprint, createdAt: stored.createdAt }, json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Rust bridge') || msg.includes('RUST_CHAIN_ENABLED')) {
      console.error('Error: Vault requires the Rust bridge. Run: npm run build:rust');
    } else {
      console.error(`Error: ${msg}`);
    }
    return true;
  }
  return true;
}

function handleSecretGet(context: CliContext): boolean {
  const { json, key } = context.args;
  if (!key) throw new Error('secret get requires --key <name>');

  const result = readVaultSecretByKey(key, { surface: 'cli', command: 'secret get' }, process.env);
  if (!result.found) {
    print({ ok: false, key, error: 'Secret not found' }, json);
    return true;
  }

  if (result.error) {
    console.error(`Error decrypting: ${result.error}`);
    return true;
  }

  print({ ok: true, key, value: result.plaintext, createdAt: result.createdAt }, json);
  return true;
}

function handleSecretList(context: CliContext): boolean {
  const { json, key } = context.args;
  const entries = listVaultEntryMetadata(
    { surface: 'cli', command: 'secret list' },
    process.env,
    key,
    { latestPerKey: true },
  );

  if (json) {
    print(
      {
        ok: true,
        count: entries.length,
        secrets: entries.map((entry) => ({
          key: entry.key,
          latestAt: entry.createdAt,
          integrityOk: entry.integrityOk,
          fingerprint: entry.fingerprint,
        })),
      },
      true,
    );
  } else {
    if (entries.length === 0) {
      console.log('No secrets stored.');
    } else {
      console.log(`Secrets (${entries.length} key${entries.length > 1 ? 's' : ''}):`);
      for (const entry of entries) {
        console.log(`  ${entry.key} (${entry.createdAt}) integrity=${entry.integrityOk}`);
      }
    }
  }
  return true;
}
