import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import chalk from 'chalk';

import { storeVaultSecret } from '../../../security/vault-boundary.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import {
  getTelegramReadinessStatus,
} from '../../../gateway/channels/telegram-readiness.js';
import { sendTelegramMessage } from '../../../gateway/channels/telegram-send.js';
import { print } from '../utils/render.js';

const TELEGRAM_BOT_TOKEN_VAULT_KEY = 'telegram_bot_token';
const TELEGRAM_ALLOWED_USER_IDS_VAULT_KEY = 'telegram_allowed_user_ids';

function findEnvPath(): string {
  const candidates = ['.env', '../.env', '../../.env'];
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }
  return '.env';
}

function updateEnvFileWithVaultRef(envPath: string, envKey: string, vaultKey: string): void {
  const resolved = resolve(envPath);
  let content = '';
  if (existsSync(resolved)) {
    content = readFileSync(resolved, 'utf8');
  }

  const lineToAdd = `${envKey}=VAULT:${vaultKey}`;
  const regex = new RegExp(`^${envKey}=.*$`, 'm');

  if (regex.test(content)) {
    content = content.replace(regex, lineToAdd);
  } else {
    content = content.trimEnd();
    content += `\n${lineToAdd}\n`;
  }

  writeFileSync(resolved, content, 'utf8');
}

export const telegramCommandHandler: CommandHandler = {
  name: 'telegram',
  commands: ['telegram'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'telegram';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    const handlers: Record<string, () => Promise<boolean>> = {
      configure: () => handleTelegramConfigure(context),
      send: () => handleTelegramSend(context),
      status: () => handleTelegramStatus(context),
    };
    const handler = subcommand ? handlers[subcommand] : handlers.status;
    return handler();
  },
};

async function handleTelegramSend(context: CliContext): Promise<boolean> {
  const { json, value: message, to: chatId } = context.args;
  if (!message) {
    throw new Error('telegram send requires --value <message>');
  }
  const result = await sendTelegramMessage({ message, chatId, rawEnv: process.env, fetchImpl: fetch });
  print(result, json);
  return true;
}

async function handleTelegramConfigure(context: CliContext): Promise<boolean> {
  const { json, botToken, allowedUserIds } = context.args;

  if (!botToken) {
    throw new Error('--bot-token is required. Usage: memphis telegram configure --bot-token <token> --allowed-user-ids <ids>');
  }

  if (!allowedUserIds) {
    throw new Error('--allowed-user-ids is required. Usage: memphis telegram configure --bot-token <token> --allowed-user-ids <ids>');
  }

  const envPath = findEnvPath();

  try {
    // Store bot token in vault
    storeVaultSecret(
      TELEGRAM_BOT_TOKEN_VAULT_KEY,
      botToken,
      { surface: 'cli', command: 'telegram configure' },
      process.env,
    );

    // Store allowed user IDs in vault
    storeVaultSecret(
      TELEGRAM_ALLOWED_USER_IDS_VAULT_KEY,
      allowedUserIds,
      { surface: 'cli', command: 'telegram configure' },
      process.env,
    );

    // Update .env with vault references
    updateEnvFileWithVaultRef(envPath, 'MEMPHIS_TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN_VAULT_KEY);
    updateEnvFileWithVaultRef(envPath, 'MEMPHIS_TELEGRAM_ALLOWED_USER_IDS', TELEGRAM_ALLOWED_USER_IDS_VAULT_KEY);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (error.includes('Rust bridge') || error.includes('RUST_CHAIN_ENABLED')) {
      throw new Error('Vault requires the Rust bridge. Run: npm run build:rust');
    }
    throw err;
  }

  const result = {
    ok: true,
    envPath,
    configured: {
      botToken: 'stored in vault',
      allowedUserIds: 'stored in vault',
    },
    message: 'Telegram secrets stored in vault. Add MEMPHIS_CHANNEL_GATEWAY_ENABLED=true to your .env to enable inbound messages.',
  };

  if (!json) {
    console.log(chalk.green.bold('\n✓ Telegram configured successfully\n'));
    console.log(`  Bot token: ${chalk.cyan('stored in vault')}`);
    console.log(`  Allowed user IDs: ${chalk.cyan(allowedUserIds)}`);
    console.log(`  Config file: ${chalk.gray(envPath)}`);
    console.log(chalk.gray('\n  Add MEMPHIS_CHANNEL_GATEWAY_ENABLED=true to enable inbound messages.\n'));
  }

  print(result, json);
  return true;
}

async function handleTelegramStatus(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const status = await getTelegramReadinessStatus(process.env, {
    fetchImpl: fetch,
    includeRemoteBotLookup: true,
  });

  if (json) {
    print(status, true);
  } else {
    console.log(`Telegram: ${status.state}`);
    console.log(`  Gateway enabled: ${status.gatewayEnabled ? 'yes' : 'no'}`);
    console.log(`  Token: ${status.configured ? `present (${status.tokenSource ?? 'unknown'})` : 'missing'}`);
    console.log(`  Allowlist: ${status.allowlistEnabled ? `${status.allowlistCount} ids` : 'open'}`);
    if (status.botName) console.log(`  Bot: @${status.botName}`);
    if (status.chatId) console.log(`  Chat ID: ${status.chatId}`);
    if (!status.configured) {
      console.log(
        '  Set MEMPHIS_TELEGRAM_BOT_TOKEN and MEMPHIS_TELEGRAM_CHAT_ID in your .env',
      );
    } else if (!status.gatewayEnabled) {
      console.log('  Set MEMPHIS_CHANNEL_GATEWAY_ENABLED=true to enable inbound Telegram chat');
    }
  }
  return true;
}
