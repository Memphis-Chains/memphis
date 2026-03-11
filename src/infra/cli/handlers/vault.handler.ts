import { vaultDecrypt, vaultEncrypt, vaultInit } from '../../storage/rust-vault-adapter.js';
import { listVaultEntries, saveVaultEntry } from '../../storage/vault-entry-store.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

export const vaultCommandHandler: CommandHandler = {
  name: 'vault',
  commands: ['vault'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'vault';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      init: async () => handleVaultInit(context),
      add: async () => handleVaultAdd(context),
      get: async () => handleVaultGet(context),
      list: async () => handleVaultList(context),
    };
    const handler = subcommand ? handlers[subcommand] : undefined;
    if (!handler) throw new Error(`Unknown vault subcommand: ${String(subcommand)}`);
    return handler();
  },
};

function handleVaultInit(context: CliContext): boolean {
  const { json, passphrase, recoveryAnswer, recoveryQuestion } = context.args;
  if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
    throw new Error('vault init requires --passphrase --recovery-question --recovery-answer');
  }
  print(
    {
      ok: true,
      vault: vaultInit(
        { passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer },
        process.env,
      ),
    },
    json,
  );
  return true;
}

function handleVaultAdd(context: CliContext): boolean {
  const { json, key, value } = context.args;
  if (!key || value === undefined) throw new Error('vault add requires --key and --value');
  const encrypted = vaultEncrypt(key, value, process.env);
  print({ ok: true, entry: saveVaultEntry(encrypted, process.env) }, json);
  return true;
}

function handleVaultGet(context: CliContext): boolean {
  const { json, key } = context.args;
  if (!key) throw new Error('vault get requires --key');
  const latest = listVaultEntries(process.env, key).at(-1);
  if (!latest) throw new Error(`vault key not found: ${key}`);
  print({ ok: true, key, value: vaultDecrypt(latest, process.env) }, json);
  return true;
}

function handleVaultList(context: CliContext): boolean {
  print({ ok: true, entries: listVaultEntries(process.env, context.args.key) }, context.args.json);
  return true;
}
