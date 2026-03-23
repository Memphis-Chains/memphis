import { vaultDecrypt, vaultEncrypt } from '../../storage/rust-vault-adapter.js';
import {
  getLatestVaultEntry,
  listVaultEntries,
  saveVaultEntry,
} from '../../storage/vault-entry-store.js';
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
    return handler();
  },
};

function handleSecretAdd(context: CliContext): boolean {
  const { json, key, value } = context.args;
  if (!key || value === undefined) {
    throw new Error('secret add requires --key <name> and --value <plaintext>');
  }

  try {
    const encrypted = vaultEncrypt(key, value, process.env);
    const stored = saveVaultEntry(encrypted, process.env);
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

  const entry = getLatestVaultEntry(key);
  if (!entry) {
    print({ ok: false, key, error: 'Secret not found' }, json);
    return true;
  }

  try {
    const plaintext = vaultDecrypt(entry, process.env);
    print({ ok: true, key, value: plaintext, createdAt: entry.createdAt }, json);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Rust bridge') || msg.includes('RUST_CHAIN_ENABLED')) {
      console.error('Error: Vault requires the Rust bridge. Run: npm run build:rust');
    } else {
      console.error(`Error decrypting: ${msg}`);
    }
  }
  return true;
}

function handleSecretList(context: CliContext): boolean {
  const { json, key } = context.args;
  const entries = listVaultEntries(process.env, key);

  if (json) {
    const keys = new Map<string, { count: number; latestAt: string }>();
    for (const e of entries) {
      const existing = keys.get(e.key);
      if (!existing || e.createdAt > existing.latestAt) {
        keys.set(e.key, { count: (existing?.count ?? 0) + 1, latestAt: e.createdAt });
      }
    }
    print(
      {
        ok: true,
        count: keys.size,
        secrets: [...keys.entries()].map(([k, v]) => ({
          key: k,
          versions: v.count,
          latestAt: v.latestAt,
        })),
      },
      true,
    );
  } else {
    if (entries.length === 0) {
      console.log('No secrets stored.');
    } else {
      const keys = new Map<string, number>();
      for (const e of entries) {
        keys.set(e.key, (keys.get(e.key) ?? 0) + 1);
      }
      console.log(`Secrets (${keys.size} keys, ${entries.length} total entries):`);
      for (const [k, count] of keys) {
        console.log(`  ${k} (${count} version${count > 1 ? 's' : ''})`);
      }
    }
  }
  return true;
}
