import { listVaultEntries, saveVaultEntry } from '../../storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../../storage/rust-vault-adapter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';
import type { CommandHandler } from './command-handler.js';

export const vaultCommandHandler: CommandHandler = {
  name: 'vault',
  commands: ['vault'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'vault';
  },
  async handle(context: CliContext): Promise<boolean> {
    const {
      json,
      key,
      passphrase,
      recoveryAnswer,
      recoveryQuestion,
      subcommand,
      value,
    } = context.args;

    if (subcommand === 'init') {
      if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
        throw new Error('vault init requires --passphrase --recovery-question --recovery-answer');
      }
      print(
        {
          ok: true,
          vault: vaultInit(
            {
              passphrase,
              recovery_question: recoveryQuestion,
              recovery_answer: recoveryAnswer,
            },
            process.env,
          ),
        },
        json,
      );
      return true;
    }

    if (subcommand === 'add') {
      if (!key || value === undefined) {
        throw new Error('vault add requires --key and --value');
      }
      const encrypted = vaultEncrypt(key, value, process.env);
      print({ ok: true, entry: saveVaultEntry(encrypted, process.env) }, json);
      return true;
    }

    if (subcommand === 'get') {
      if (!key) {
        throw new Error('vault get requires --key');
      }
      const latest = listVaultEntries(process.env, key).at(-1);
      if (!latest) {
        throw new Error(`vault key not found: ${key}`);
      }
      print({ ok: true, key, value: vaultDecrypt(latest, process.env) }, json);
      return true;
    }

    if (subcommand === 'list') {
      print({ ok: true, entries: listVaultEntries(process.env, key) }, json);
      return true;
    }

    throw new Error(`Unknown vault subcommand: ${String(subcommand)}`);
  },
};
