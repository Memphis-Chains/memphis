import type { TuiHostCapability } from './protocol.js';
import { createAppContainer } from '../../app/container.js';
import { getCognitiveModeConfig, isValidCognitiveMode } from '../../cognitive/modes.js';
import {
  getActiveSurfacesSnapshot,
  recordSurfaceActivity,
  type SurfaceActivitySnapshot,
} from '../../core/surface-presence.js';
import { sendTelegramMessage } from '../../gateway/channels/telegram-send.js';
import {
  buildSurfacePolicySnapshot,
  getSurfacePolicyEnvKey,
  listSurfacePolicyOverrides,
  normalizeSurfacePolicySettingName,
  parseSurfacePolicySettingValue,
  resolveSurfacePolicy,
} from '../../gateway/surface-policy.js';
import { KnowledgeService } from '../../modules/knowledge/service.js';
import { inspectFirstRunStatusReport } from '../../onboarding/first-run.js';
import {
  getActiveTier3Session,
  getTier3RemainingMs,
  requestTier3Elevation,
  revokeTier3Session,
} from '../../security/tier3-session.js';
import { getCognitiveMode, setCognitiveMode } from '../../soul/manifest.js';
import type { CognitiveMode } from '../../soul/types.js';
import { handleAppsCommand } from '../cli/commands/apps.js';
import {
  generateInsightsCommandData,
  generateReflectCommandData,
} from '../cli/commands/cognitive.js';
import { handleDecisionCommand } from '../cli/commands/decision.js';
import { handleSyncCommand } from '../cli/commands/sync.js';
import { createCliContext, type CliContext } from '../cli/context.js';
import { parseCommand } from '../cli/parser.js';
import type { CliArgs } from '../cli/types.js';
import { runDoctorChecksV2 } from '../cli/utils/doctor-v2.js';
import { setDotEnvValues, unsetDotEnvValues } from '../config/dotenv-file.js';
import { loadConfig } from '../config/env.js';
import {
  performHotReload,
  redactFieldValue,
} from '../config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
} from '../config/mutability.js';
import { envSchema } from '../config/schema.js';
import { buildHealthPayload } from '../http/health.js';
import { buildOperatorGuide } from '../operator-guide.js';
import { loadPulseEntries, writePulseEvent } from '../runtime/heartbeat-watchdog.js';
import { verifyChainIntegrity } from '../storage/chain-adapter.js';
import { createSqliteClient, runMigrations } from '../storage/sqlite/client.js';
import { SqliteToolCallApprovalRepository } from '../storage/sqlite/repositories/tool-call-approval-repository.js';
import { SqliteToolPermissionRepository } from '../storage/sqlite/repositories/tool-permission-repository.js';

export type TuiHostCommandContext = {
  emitLine: (
    level: 'info' | 'warning' | 'error',
    text: string,
    extras?: { temperature?: number; chainCount?: number },
  ) => void;
  signal: AbortSignal;
};

export async function executeTuiHostCommand(
  command: TuiHostCapability,
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  assertNotAborted(context.signal);
  await maybeApplyTestDelay(args, context.signal);

  const tuiSessionId = optionalStringArg(args, 'hostSessionId') ?? 'tui-local';
  const activeTier3 = getActiveTier3Session(TUI_TIER_SURFACE, TUI_TIER_ACTOR_ID);
  recordSurfaceActivity({
    surface: 'tui',
    actorId: TUI_TIER_ACTOR_ID,
    tier: activeTier3 ? 3 : 2,
    tuiHostSessionId: tuiSessionId,
  });

  switch (command) {
    case 'guide.show':
      return executeGuideShow(context);
    case 'telegram.send':
      return executeTelegramSend(args, context);
    case 'init.status':
      return executeInitStatus(context);
    case 'health.status':
      return executeHealthStatus(context);
    case 'doctor.run':
      return executeDoctorRun(args, context);
    case 'agents.list':
      return executeDecisionCliCommand(['agents', 'list'], context);
    case 'agents.discover':
      return executeDecisionCliCommand(['agents', 'discover'], context);
    case 'agents.show':
      return executeDecisionCliCommand(['agents', 'show', requireStringArg(args, 'did')], context);
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
    case 'knowledge.status':
      return executeKnowledgeStatus(context);
    case 'knowledge.query':
      return executeKnowledgeQuery(args, context);
    case 'config.tools.list':
      return executeConfigToolsList(context);
    case 'config.tools.check':
      return executeConfigToolsCheck(args, context);
    case 'config.tools.pending':
      return executeConfigToolsPending(context);
    case 'config.surfaces.list':
      return executeConfigSurfacesList(context);
    case 'config.surfaces.check':
      return executeConfigSurfacesCheck(args, context);
    case 'config.surfaces.set':
      return executeConfigSurfacesSet(args, context);
    case 'config.surfaces.reset':
      return executeConfigSurfacesReset(args, context);
    case 'config.show':
      return executeConfigShow(args, context);
    case 'config.set':
      return executeConfigSet(args, context);
    case 'config.reload':
      return executeConfigReload(context);
    case 'pulse.status':
      return executePulseStatus(context);
    case 'cognitive.mode':
      return executeCognitiveMode(args, context);
    case 'security.tier.status':
      return executeSecurityTierStatus(context);
    case 'security.tier.elevate':
      return executeSecurityTierElevate(args, context);
    case 'security.tier.revoke':
      return executeSecurityTierRevoke(context);
    case 'presence.snapshot':
      return executePresenceSnapshot(context);
    default:
      return exhaustiveCapability(command);
  }
}

async function executePresenceSnapshot(
  context: TuiHostCommandContext,
): Promise<unknown> {
  context.emitLine('info', 'Loading cross-surface presence snapshot...');
  const snapshots = getActiveSurfacesSnapshot();
  assertNotAborted(context.signal);
  const activeCount = snapshots.filter((s: SurfaceActivitySnapshot) => !s.stale).length;
  context.emitLine(
    activeCount === 0 ? 'warning' : 'info',
    `Surfaces: ${snapshots.length} tracked, ${activeCount} active`,
  );
  return { snapshots, active: activeCount, total: snapshots.length };
}

async function executeGuideShow(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading Memphis operator guide...');
  const guide = buildOperatorGuide(process.env);
  assertNotAborted(context.signal);
  context.emitLine(
    'info',
    `Guide ready for ${guide.agentName} (${guide.sections.length} sections).`,
  );
  return guide;
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

async function executeInitStatus(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Inspecting Memphis first-run state...');
  const result = inspectFirstRunStatusReport(process.env);
  assertNotAborted(context.signal);
  context.emitLine(
    result.state === 'initialized-clean' ? 'info' : 'warning',
    `First-run state=${result.state} action=${result.recommendedAction} next=${result.plan.nextCommand}`,
  );
  return result;
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
    `Doctor summary: pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} repair=${report.repairStatus}`,
  );
  for (const check of report.checks.filter((item) => item.level !== 'pass').slice(0, 10)) {
    context.emitLine(check.level === 'fail' ? 'error' : 'warning', `${check.id}: ${check.detail}`);
  }
  return report;
}

async function executeHealthStatus(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading Memphis runtime health...');

  // Get cognitive mode temperature
  const cognitiveMode = getCognitiveMode();
  const modeConfig = getCognitiveModeConfig(cognitiveMode);

  // Get chain block count
  let chainCount = 0;
  try {
    const chainResult = await verifyChainIntegrity();
    chainCount = chainResult.blockCount;
  } catch {
    // Chain count is best-effort
  }

  const container = createAppContainer(loadConfig());
  const result = await buildHealthPayload(loadConfig(), process.env, {
    workPolling: container.workPollingService.snapshot(),
  });
  assertNotAborted(context.signal);

  context.emitLine(
    result.status === 'healthy' ? 'info' : 'warning',
    `Runtime health=${result.status} recall=${result.runtime.memory.recallMode} embeddings=${result.runtime.embeddings.status} repair=${result.runtime.repair.status} init=${result.runtime.firstRun.state} scheduler=${result.scheduler?.effectiveTarget ?? 'local'}`,
    { temperature: modeConfig.temperature, chainCount },
  );
  return result;
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
  const argv = [
    'apps',
    'plan',
    id,
    ...optionalFlagValue('--action', action),
    ...optionalFlagValue('--file', file),
  ];
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
  context.emitLine(
    'info',
    `Generating ${window ?? 'daily'} insights${topic ? ` for ${topic}` : ''}...`,
  );
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

async function executeKnowledgeStatus(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading curated knowledge sources...');
  const result = new KnowledgeService({ workspaceRoot: process.cwd() }).buildStatus();
  assertNotAborted(context.signal);
  context.emitLine(
    'info',
    `Knowledge sources loaded=${result.summary.loaded} missing=${result.summary.missingOptional + result.summary.missingRequired}`,
  );
  return result;
}

async function executeKnowledgeQuery(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const topic = requireStringArg(args, 'topic');
  const source = optionalStringArg(args, 'source');
  const limit = optionalNumberArg(args, 'limit');
  context.emitLine('info', `Querying curated knowledge for ${topic}...`);
  const result = new KnowledgeService({ workspaceRoot: process.cwd() }).query(topic, {
    source,
    limit,
  });
  assertNotAborted(context.signal);
  context.emitLine('info', `Knowledge hits: ${result.hits.length}`);
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

async function executeConfigSurfacesList(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading surface capability policies...');
  const surfaces = buildSurfacePolicySnapshot(process.env).map((policy) => ({
    ...policy,
    overrides: listSurfacePolicyOverrides(policy.surface, process.env),
  }));
  assertNotAborted(context.signal);
  context.emitLine('info', `Loaded ${surfaces.length} surface policy snapshot(s).`);
  return { surfaces };
}

async function executeConfigSurfacesCheck(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const surface = requireStringArg(args, 'surface');
  context.emitLine('info', `Checking surface capability policy for ${surface}...`);
  const policy = resolveSurfacePolicy(surface, process.env);
  const overrides = listSurfacePolicyOverrides(surface, process.env);
  assertNotAborted(context.signal);
  return { surface: policy.surface, policy, overrides };
}

async function executeConfigSurfacesSet(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const surface = requireStringArg(args, 'surface');
  const settingInput = requireStringArg(args, 'setting');
  const valueInput = requireStringArg(args, 'value');
  const setting = normalizeSurfacePolicySettingName(settingInput);
  if (!setting) {
    throw new Error(`Unknown surface policy setting: ${settingInput}`);
  }
  const value = parseSurfacePolicySettingValue(setting, valueInput);
  const envKey = getSurfacePolicyEnvKey(surface, setting);
  context.emitLine('info', `Setting ${envKey}=${value}...`);
  const result = setDotEnvValues({ [envKey]: value }, process.env);
  process.env[envKey] = value;
  assertNotAborted(context.signal);
  const policy = resolveSurfacePolicy(surface, process.env);
  context.emitLine('info', `Surface ${policy.surface} now enforces tier=${policy.maxToolTier}.`);
  return { envPath: result.path, updatedKeys: result.updatedKeys, surface: policy.surface, policy };
}

async function executeConfigSurfacesReset(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const surface = requireStringArg(args, 'surface');
  const settingInput = optionalStringArg(args, 'setting');
  const keys = settingInput
    ? (() => {
        const setting = normalizeSurfacePolicySettingName(settingInput);
        if (!setting) {
          throw new Error(`Unknown surface policy setting: ${settingInput}`);
        }
        return [getSurfacePolicyEnvKey(surface, setting)];
      })()
    : listSurfacePolicyOverrides(surface, process.env).map((item) => item.envKey);

  context.emitLine(
    'info',
    keys.length === 0
      ? `No overrides found for ${surface}.`
      : `Resetting ${keys.length} surface override(s) for ${surface}...`,
  );
  const result = unsetDotEnvValues(keys, process.env);
  for (const key of keys) {
    delete process.env[key];
  }
  assertNotAborted(context.signal);
  const policy = resolveSurfacePolicy(surface, process.env);
  return { envPath: result.path, removedKeys: result.removedKeys, surface: policy.surface, policy };
}

async function executeConfigShow(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const key = optionalStringArg(args, 'key');
  const fields = listKnownFields();
  const values: Record<string, string> = {};
  const targetKeys = key ? [key] : fields.map((f) => f.key);
  for (const name of targetKeys) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    values[name] = redactFieldValue(name, raw);
  }
  assertNotAborted(context.signal);
  const shown = Object.keys(values).length;
  context.emitLine('info', key ? `Config: ${key}=${values[key] ?? '(unset)'}` : `Config: ${shown} field(s) shown`);
  return { fields, values, requestedKey: key ?? null };
}

async function executeConfigSet(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const key = requireStringArg(args, 'key');
  const value = requireStringArg(args, 'value');
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('value must not contain newline characters');
  }
  if (requiresRestart(key)) {
    throw new Error(`${key} is a cold field — restart required; refused.`);
  }
  if (requiresElevatedTier(key)) {
    const active = getActiveTier3Session(TUI_TIER_SURFACE, TUI_TIER_ACTOR_ID);
    if (!active) {
      throw new Error(
        `${key} is a secret field — requires tier-3 elevation. Run \`security.tier.elevate\` first.`,
      );
    }
  }
  const schema = envSchema.partial();
  const candidate = { ...process.env, [key]: value };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.includes(key));
    throw new Error(`Validation failed for ${key}: ${issue?.message ?? 'invalid value'}`);
  }
  context.emitLine('info', `Setting ${key}... (tier=${classifyField(key)})`);
  setDotEnvValues({ [key]: value }, process.env);
  process.env[key] = value;
  assertNotAborted(context.signal);
  context.emitLine('info', `${key}=${redactFieldValue(key, value)} applied.`);
  return { key, tier: classifyField(key), newValue: redactFieldValue(key, value) };
}

async function executeConfigReload(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Reloading config from .env...');
  const result = performHotReload();
  assertNotAborted(context.signal);
  if (!result.ok) {
    if (result.validationError) {
      context.emitLine('error', `Reload blocked — ${result.validationError}`);
    } else if (result.rejectedCold.length > 0) {
      context.emitLine(
        'warning',
        `Reload blocked — cold fields require restart: ${result.rejectedCold.join(', ')}`,
      );
    }
    return result;
  }
  context.emitLine(
    'info',
    `Reload applied ${result.appliedCount} field(s); ${result.unchangedCount} unchanged.`,
  );
  return result;
}

async function executePulseStatus(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Loading PULSE heartbeat entries...');
  const entries = loadPulseEntries();
  assertNotAborted(context.signal);

  const latest = entries.length > 0 ? entries[entries.length - 1]! : null;
  const summary = {
    totalEntries: entries.length,
    lastEvent: latest?.event ?? null,
    lastHealth: latest?.health ?? null,
    lastTimestamp: latest?.timestamp ?? null,
    uptimeSeconds: latest?.uptimeSeconds ?? null,
  };

  context.emitLine(
    entries.length === 0 ? 'warning' : 'info',
    `PULSE: ${entries.length} entry(s)${latest ? ` | last=${latest.event} ${latest.health}` : ' | no entries'}`,
  );

  return { entries, summary };
}

async function executeCognitiveMode(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const subcommand = optionalStringArg(args, 'subcommand');

  if (!subcommand || subcommand === 'get') {
    return executeCognitiveModeGet(context);
  }

  if (subcommand === 'set') {
    return executeCognitiveModeSet(args, context);
  }

  throw new Error('cognitive.mode requires subcommand: get | set <A|B|C|D|E>');
}

async function executeCognitiveModeGet(context: TuiHostCommandContext): Promise<unknown> {
  context.emitLine('info', 'Getting cognitive mode...');
  const currentMode = getCognitiveMode();
  const config = getCognitiveModeConfig(currentMode);
  assertNotAborted(context.signal);

  context.emitLine('info', `Cognitive mode: ${currentMode} (${config.name})`);
  return { mode: currentMode, config };
}

async function executeCognitiveModeSet(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const newMode = optionalStringArg(args, 'mode');
  if (!newMode) {
    throw new Error('cognitive.mode set requires --mode <A|B|C|D|E>');
  }

  if (!isValidCognitiveMode(newMode)) {
    throw new Error(`Invalid cognitive mode: ${newMode}. Must be A, B, C, D, or E.`);
  }

  context.emitLine('info', `Setting cognitive mode to ${newMode}...`);
  const previousMode = getCognitiveMode();
  setCognitiveMode(newMode as CognitiveMode);
  assertNotAborted(context.signal);

  const config = getCognitiveModeConfig(newMode as CognitiveMode);
  context.emitLine('info', `Cognitive mode: ${previousMode} → ${newMode} (${config.name})`);

  // Record mode change in PULSE
  try {
    writePulseEvent({
      timestamp: new Date().toISOString(),
      event: 'mode-change',
      health: 'healthy',
      uptimeSeconds: Math.floor(process.uptime()),
      cognitiveMode: newMode,
      detail: `mode change: ${previousMode} → ${newMode}`,
    });
  } catch {
    // PULSE write is non-fatal
  }

  return { previousMode, mode: newMode, config };
}

const TUI_TIER_SURFACE = 'tui' as const;
const TUI_TIER_ACTOR_ID = 'local' as const;

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
}

async function executeSecurityTierStatus(
  context: TuiHostCommandContext,
): Promise<unknown> {
  const session = getActiveTier3Session(TUI_TIER_SURFACE, TUI_TIER_ACTOR_ID);
  const remainingMs = session
    ? getTier3RemainingMs(TUI_TIER_SURFACE, TUI_TIER_ACTOR_ID)
    : 0;
  const tier = session ? 3 : 2;
  assertNotAborted(context.signal);
  context.emitLine(
    'info',
    session
      ? `Tier ${tier} active for ${formatRemaining(remainingMs)} (expires ${new Date(session.expiresAt).toISOString()}).`
      : 'Tier 2 (default). No elevation active.',
  );
  return {
    surface: TUI_TIER_SURFACE,
    actorId: TUI_TIER_ACTOR_ID,
    tier,
    session: session
      ? {
          grantedAt: new Date(session.grantedAt).toISOString(),
          expiresAt: new Date(session.expiresAt).toISOString(),
          remainingMs,
        }
      : null,
  };
}

async function executeSecurityTierElevate(
  args: Record<string, unknown> | undefined,
  context: TuiHostCommandContext,
): Promise<unknown> {
  const tierInput = optionalNumberArg(args, 'tier') ?? 3;
  if (tierInput !== 3) {
    throw new Error('Only tier 3 elevation is supported via /tier');
  }
  const passphrase = requireStringArg(args, 'passphrase');
  context.emitLine('info', 'Requesting tier 3 elevation...');
  const result = requestTier3Elevation({
    surface: TUI_TIER_SURFACE,
    actorId: TUI_TIER_ACTOR_ID,
    passphrase,
    rawEnv: process.env,
  });
  assertNotAborted(context.signal);
  if (!result.ok) {
    context.emitLine('error', `Tier 3 denied: ${result.message}`);
    return { ok: false, reason: result.reason, message: result.message };
  }
  const remainingMs = getTier3RemainingMs(TUI_TIER_SURFACE, TUI_TIER_ACTOR_ID);
  context.emitLine(
    'info',
    `Tier 3 granted. Expires ${new Date(result.session.expiresAt).toISOString()} (${formatRemaining(remainingMs)} remaining).`,
  );
  return {
    ok: true,
    surface: TUI_TIER_SURFACE,
    actorId: TUI_TIER_ACTOR_ID,
    tier: 3,
    grantedAt: new Date(result.session.grantedAt).toISOString(),
    expiresAt: new Date(result.session.expiresAt).toISOString(),
    remainingMs,
  };
}

async function executeSecurityTierRevoke(
  context: TuiHostCommandContext,
): Promise<unknown> {
  const revoked = revokeTier3Session(
    TUI_TIER_SURFACE,
    TUI_TIER_ACTOR_ID,
    'manual',
    process.env,
  );
  assertNotAborted(context.signal);
  context.emitLine(
    revoked ? 'info' : 'warning',
    revoked
      ? 'Tier 3 revoked; default tier 2 restored.'
      : 'No active tier 3 elevation to revoke.',
  );
  return { revoked, surface: TUI_TIER_SURFACE, actorId: TUI_TIER_ACTOR_ID };
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

function requireStringArg(args: Record<string, unknown> | undefined, key: string): string {
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

function optionalTargetArg(args: Record<string, unknown> | undefined, key: string): string[] {
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
