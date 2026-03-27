import type { TuiHostCapability } from './protocol.js';
import { createAppContainer } from '../../app/container.js';
import { sendTelegramMessage } from '../../gateway/channels/telegram-send.js';
import { handleAppsCommand } from '../cli/commands/apps.js';
import { generateInsightsCommandData, generateReflectCommandData } from '../cli/commands/cognitive.js';
import { handleDecisionCommand } from '../cli/commands/decision.js';
import { handleSyncCommand } from '../cli/commands/sync.js';
import {
  createCliContext,
  type CliContext,
} from '../cli/context.js';
import { parseCommand } from '../cli/parser.js';
import type { CliArgs } from '../cli/types.js';
import { runDoctorChecksV2 } from '../cli/utils/doctor-v2.js';
import { loadConfig } from '../config/env.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';
import { SqliteToolCallApprovalRepository } from '../storage/sqlite/repositories/tool-call-approval-repository.js';
import { SqliteToolPermissionRepository } from '../storage/sqlite/repositories/tool-permission-repository.js';

export type TuiHostCommandContext = {
  emitLine: (level: 'info' | 'warning' | 'error', text: string) => void;
  signal: AbortSignal;
};

export async function executeTuiHostCommand(
  command: TuiHostCapability,
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  assertNotAborted(context.signal);
  await maybeApplyTestDelay(args, context.signal);

  switch (command) {
    case 'telegram.send':
      return executeTelegramSend(args, context);
    case 'doctor.run':
      return executeDoctorRun(args, context);
    case 'agents.list':
      return executeDecisionCliCommand(['agents', 'list'], context);
    case 'agents.discover':
      return executeDecisionCliCommand(['agents', 'discover'], context);
    case 'agents.show':
      return executeDecisionCliCommand(
        ['agents', 'show', requireStringArg(args, 'did')],
        context,
      );
    case 'sync.status':
      return executeSyncStatus(args, context);
    case 'apps.list':
      return executeAppsCommand(['apps', 'list'], context);
    case 'apps.show':
      return executeAppsCommand(
        [
          'apps',
          'show',
          ...optionalTargetArg(args, 'id'),
          ...optionalFlagValue('--file', optionalStringArg(args, 'file')),
        ],
        context,
      );
    case 'apps.plan':
      return executeAppsPlan(args, context);
    case 'reflect.run':
      return executeReflectRun(args, context);
    case 'insights.run':
      return executeInsightsRun(args, context);
    case 'config.tools.list':
      return executeConfigToolsList(context);
    case 'config.tools.check':
      return executeConfigToolsCheck(args, context);
    case 'config.tools.pending':
      return executeConfigToolsPending(context);
    default:
      return exhaustiveCapability(command);
  }
}

async function executeTelegramSend(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const message = requireStringArg(args, 'message');
  const chatId = optionalStringArg(args, 'chatId');
  context.emitLine('info', 'Sending Telegram message through the TypeScript transport...');
  const result = await sendTelegramMessage({
    message,
    chatId,
    rawEnv: process.env,
    fetchImpl: fetch,
    signal: context.signal,
  });
  assertNotAborted(context.signal);
  if (!result.ok) {
    throw new Error(result.error ?? 'telegram send failed');
  }
  return { messageId: result.messageId, chatId: result.chatId };
}

async function executeDoctorRun(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  context.emitLine('info', 'Running Memphis doctor checks...');
  const container = createAppContainer(loadConfig());
  const report = await runDoctorChecksV2({
    fix: optionalBooleanArg(args, 'fix'),
    force: optionalBooleanArg(args, 'force'),
    deep: optionalBooleanArg(args, 'deep'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getContainer: () => container as any,
  });
  assertNotAborted(context.signal);
  context.emitLine(
    report.ok ? 'info' : 'warning',
    `Doctor summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
  );
  for (const check of report.checks.filter((item) => item.level !== 'pass').slice(0, 10)) {
    context.emitLine(
      check.level === 'fail' ? 'error' : 'warning',
      `${check.id}: ${check.detail}`,
    );
  }
  return report;
}

async function executeDecisionCliCommand(
  argv: string[],
  context: TuiHostCommandContext,
): Promise<unknown> {
  context.emitLine('info', `Resolving ${argv.join(' ')}...`);
  const result = await captureJsonCliCommand(argv, handleDecisionCommand);
  assertNotAborted(context.signal);
  return result;
}

async function executeSyncStatus(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const chain = optionalStringArg(args, 'chain');
  context.emitLine('info', `Checking sync status${chain ? ` for ${chain}` : ''}...`);
  const result = await captureJsonCliCommand(
    ['sync', 'status', ...optionalFlagValue('--chain', chain)],
    handleSyncCommand,
  );
  assertNotAborted(context.signal);
  return result;
}

async function executeAppsCommand(
  argv: string[],
  context: TuiHostCommandContext,
): Promise<unknown> {
  context.emitLine('info', `Loading ${argv.slice(1).join(' ')}...`);
  const result = await captureJsonCliCommand(argv, handleAppsCommand);
  assertNotAborted(context.signal);
  return result;
}

async function executeAppsPlan(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const id = requireStringArg(args, 'id');
  const action = optionalStringArg(args, 'action');
  const file = optionalStringArg(args, 'file');
  const argv = ['apps', 'plan', id, ...optionalFlagValue('--action', action), ...optionalFlagValue('--file', file)];
  context.emitLine('info', `Planning managed app action for ${id}...`);
  const result = await captureJsonCliCommand(argv, handleAppsCommand);
  assertNotAborted(context.signal);
  return result;
}

async function executeReflectRun(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  context.emitLine('info', 'Generating reflection report...');
  const result = await generateReflectCommandData({ save: optionalBooleanArg(args, 'save') });
  assertNotAborted(context.signal);
  context.emitLine('info', `Generated ${result.count} reflection item(s).`);
  return result;
}

async function executeInsightsRun(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const window = optionalStringArg(args, 'window');
  const topic = optionalStringArg(args, 'topic');
  context.emitLine('info', `Generating ${window ?? 'daily'} insights${topic ? ` for ${topic}` : ''}...`);
  const result = await generateInsightsCommandData({
    argv: window === 'weekly' ? ['--weekly'] : [],
    input: topic,
    query: topic,
    subcommand: window === 'weekly' ? '--weekly' : undefined,
    save: optionalBooleanArg(args, 'save'),
  });
  assertNotAborted(context.signal);
  context.emitLine('info', `Generated ${result.count} insight item(s).`);
  return result;
}

async function executeConfigToolsList(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading tool permission rules...');
  const repo = new SqliteToolPermissionRepository(getDb());
  const tools = repo.list();
  assertNotAborted(context.signal);
  context.emitLine('info', `Loaded ${tools.length} tool permission rule(s).`);
  return { tools };
}

async function executeConfigToolsCheck(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const toolName = requireStringArg(args, 'toolName');
  context.emitLine('info', `Checking tool policy for ${toolName}...`);
  const repo = new SqliteToolPermissionRepository(getDb());
  const result = repo.isAllowed(toolName);
  assertNotAborted(context.signal);
  return { tool: toolName, ...result };
}

async function executeConfigToolsPending(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading pending tool approvals...');
  const repo = new SqliteToolCallApprovalRepository(getDb());
  repo.expirePending();
  const pending = repo.listPending();
  assertNotAborted(context.signal);
  context.emitLine('info', `${pending.length} pending approval request(s).`);
  return { pending };
}

function getDb() {
  const config = loadConfig();
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  return db;
}

function createHostCliContext(argv: string[]): CliContext {
  const fullArgv = ['node', 'memphis', ...argv, '--json'];
  const parsed = parseCommand(fullArgv);
  const args: CliArgs = { ...parsed, json: true };
  return createCliContext(fullArgv, args);
}

async function captureJsonCliCommand(
  argv: string[],
  handler: (context: CliContext) => Promise<boolean>,
): Promise<unknown> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...values: unknown[]) => {
    logs.push(values.map(String).join(' '));
  };
  console.error = (...values: unknown[]) => {
    errors.push(values.map(String).join(' '));
  };

  try {
    const context = createHostCliContext(argv);
    const handled = await handler(context);
    if (!handled) {
      throw new Error(`host command was not handled: ${argv.join(' ')}`);
    }

    const payload = logs.join('\n').trim();
    if (errors.length > 0) {
      throw new Error(errors.join('\n'));
    }
    if (!payload) {
      return {};
    }
    return JSON.parse(payload);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function requireStringArg(
  args: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = optionalStringArg(args, key);
  if (!value) {
    throw new Error(`missing required host argument: ${key}`);
  }
  return value;
}

function optionalStringArg(
  args: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalBooleanArg(
  args: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = args?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function optionalFlagValue(flag: string, value: string | undefined): string[] {
  return value ? [flag, value] : [];
}

function optionalTargetArg(
  args: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = optionalStringArg(args, key);
  return value ? [value] : [];
}

function optionalNumberArg(
  args: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = args?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

async function maybeApplyTestDelay(
  args: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  const delayMs = optionalNumberArg(args, '__testDelayMs');
  if (!delayMs || delayMs <= 0) {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < delayMs) {
    assertNotAborted(signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assertNotAborted(signal);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('cancelled');
  }
}

function exhaustiveCapability(_value: never): never {
  throw new Error('unreachable host capability');
}
