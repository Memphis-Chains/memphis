/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
import type { CommandHandler } from './command-handler.js';
import {
  buildSurfacePolicySnapshot,
  getSurfacePolicyEnvKey,
  listSurfacePolicyOverrides,
  normalizeSurfacePolicySettingName,
  parseSurfacePolicySettingValue,
  resolveSurfacePolicy,
} from '../../../gateway/surface-policy.js';
import { resolveDotEnvPath, setDotEnvValues, unsetDotEnvValues } from '../../config/dotenv-file.js';
import { loadConfig } from '../../config/env.js';
import { createSqliteClient, runMigrations } from '../../storage/sqlite/client.js';
import { SqliteToolCallApprovalRepository } from '../../storage/sqlite/repositories/tool-call-approval-repository.js';
import {
  SqliteToolPermissionRepository,
  type ToolPolicy,
} from '../../storage/sqlite/repositories/tool-permission-repository.js';
import type { CliContext } from '../context.js';

const VALID_POLICIES: ToolPolicy[] = ['allow', 'deny', 'require-approval'];

function getDb() {
  const config = loadConfig();
  const db = createSqliteClient(config.DATABASE_URL);
  runMigrations(db);
  return db;
}

function getToolRepo(): SqliteToolPermissionRepository {
  return new SqliteToolPermissionRepository(getDb());
}

function getApprovalRepo(): SqliteToolCallApprovalRepository {
  return new SqliteToolCallApprovalRepository(getDb());
}

async function handleToolsList(context: CliContext): Promise<boolean> {
  const repo = getToolRepo();
  const permissions = repo.list();

  if (context.args.json) {
    console.log(JSON.stringify({ tools: permissions }, null, 2));
    return true;
  }

  if (permissions.length === 0) {
    console.log('No tool permissions configured. All tools are allowed by default.');
    console.log('Use "memphis config tools deny <name>" to restrict a tool.');
    return true;
  }

  console.log('Tool Permissions:');
  console.log('─'.repeat(60));
  for (const p of permissions) {
    const icon = p.policy === 'allow' ? '✓' : p.policy === 'deny' ? '✗' : '⚠';
    console.log(`  ${icon} ${p.tool_name.padEnd(30)} ${p.policy}`);
  }
  console.log('─'.repeat(60));
  console.log(
    `${String(permissions.length)} tool(s) configured. Unlisted tools default to "allow".`,
  );
  return true;
}

async function handleToolsAllow(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  if (!toolName) {
    console.error('Usage: memphis config tools allow <tool-name>');
    return true;
  }
  const repo = getToolRepo();
  const result = repo.set(toolName, 'allow');
  if (context.args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`Tool '${toolName}' set to: allow`);
  }
  return true;
}

async function handleToolsDeny(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  if (!toolName) {
    console.error('Usage: memphis config tools deny <tool-name>');
    return true;
  }
  const repo = getToolRepo();
  const result = repo.set(toolName, 'deny');
  if (context.args.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(`Tool '${toolName}' set to: deny`);
  }
  return true;
}

async function handleToolsSet(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  const policy = context.args.value as ToolPolicy | undefined;
  if (!toolName || !policy) {
    console.error(
      'Usage: memphis config tools set <tool-name> --value <allow|deny|require-approval>',
    );
    return true;
  }
  if (!VALID_POLICIES.includes(policy)) {
    console.error(`Invalid policy: '${policy}'. Must be one of: ${VALID_POLICIES.join(', ')}`);
    return true;
  }
  const repo = getToolRepo();
  const result = repo.set(toolName, policy);
  if (context.args.json) {
    console.log(JSON.stringify(result));
  } else {
    const icon = policy === 'allow' ? '✓' : policy === 'deny' ? '✗' : '⚠';
    console.log(`${icon} Tool '${toolName}' set to: ${policy}`);
  }
  return true;
}

async function handleToolsReset(context: CliContext): Promise<boolean> {
  const repo = getToolRepo();
  const count = repo.reset();
  if (context.args.json) {
    console.log(JSON.stringify({ reset: true, removed: count }));
  } else {
    console.log(`Reset ${String(count)} tool permission(s). All tools now default to "allow".`);
  }
  return true;
}

async function handleToolsCheck(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  if (!toolName) {
    console.error('Usage: memphis config tools check <tool-name>');
    return true;
  }
  const repo = getToolRepo();
  const result = repo.isAllowed(toolName);
  if (context.args.json) {
    console.log(JSON.stringify({ tool: toolName, ...result }));
  } else {
    const icon = result.allowed ? '✓' : '✗';
    console.log(
      `${icon} ${toolName}: ${result.policy}${result.reason ? ` — ${result.reason}` : ''}`,
    );
  }
  return true;
}

async function handleToolsPending(context: CliContext): Promise<boolean> {
  const repo = getApprovalRepo();
  repo.expirePending();
  const pending = repo.listPending();

  if (context.args.json) {
    console.log(JSON.stringify({ pending }, null, 2));
    return true;
  }

  if (pending.length === 0) {
    console.log('No pending tool call approvals.');
    return true;
  }

  console.log('Pending Tool Call Approvals:');
  console.log('─'.repeat(80));
  for (const p of pending) {
    const args =
      p.argumentsJson.length > 60 ? p.argumentsJson.slice(0, 57) + '...' : p.argumentsJson;
    const expires = new Date(p.expiresAtMs).toLocaleTimeString();
    console.log(`  ${p.requestId}`);
    console.log(`    tool: ${p.toolName}  caller: ${p.callerId}  expires: ${expires}`);
    console.log(`    args: ${args}`);
    console.log();
  }
  console.log(`${String(pending.length)} pending request(s).`);
  console.log('Approve: memphis config tools approve-call <request-id>');
  console.log('Deny:    memphis config tools deny-call <request-id>');
  return true;
}

async function handleToolsApproveCall(context: CliContext): Promise<boolean> {
  const requestId = context.args.target;
  if (!requestId) {
    console.error('Usage: memphis config tools approve-call <request-id>');
    return true;
  }
  const repo = getApprovalRepo();
  try {
    const result = repo.approve(requestId);
    if (context.args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Approved tool call: ${result.toolName} (${requestId})`);
    }
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

async function handleToolsDenyCall(context: CliContext): Promise<boolean> {
  const requestId = context.args.target;
  if (!requestId) {
    console.error('Usage: memphis config tools deny-call <request-id>');
    return true;
  }
  const repo = getApprovalRepo();
  try {
    const result = repo.deny(requestId);
    if (context.args.json) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Denied tool call: ${result.toolName} (${requestId})`);
    }
  } catch (err) {
    console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

function parseSurfaceCommandContext(context: CliContext): {
  action?: string;
  surface?: string;
  setting?: string;
} {
  const action = context.args.target;
  const actionIdx = action ? context.argv.indexOf(action) : -1;
  const surface = actionIdx >= 0 ? context.argv[actionIdx + 1] : undefined;
  const rawSetting = actionIdx >= 0 ? context.argv[actionIdx + 2] : undefined;
  return {
    action,
    surface: surface && !surface.startsWith('--') ? surface : undefined,
    setting: rawSetting && !rawSetting.startsWith('--') ? rawSetting : undefined,
  };
}

function formatSurfacePolicyHuman(policy: ReturnType<typeof resolveSurfacePolicy>): string {
  return [
    `${policy.surface} (${policy.surfaceClass})`,
    `tier=${policy.maxToolTier}`,
    `unknownTools=${policy.allowUnknownTools ? 'yes' : 'no'}`,
    `urlFetch=${policy.allowUrlFetch ? 'yes' : 'no'}`,
    `cognitivePrelude=${policy.allowCognitivePrelude ? 'yes' : 'no'}`,
    `memoryRecall=${policy.allowMemoryRecall ? 'yes' : 'no'}`,
    `memoryWrite=${policy.allowMemoryWrite ? 'yes' : 'no'}`,
    `operatorOverride=${policy.allowOperatorOverride ? 'yes' : 'no'}`,
  ].join(' | ');
}

async function handleSurfacesList(context: CliContext, surface?: string): Promise<boolean> {
  const selected = surface?.trim();
  const policies = selected
    ? [resolveSurfacePolicy(selected, process.env)]
    : buildSurfacePolicySnapshot(process.env);
  const payload = {
    envPath: resolveDotEnvPath(process.env),
    surfaces: policies.map((policy) => ({
      ...policy,
      overrides: listSurfacePolicyOverrides(policy.surface, process.env),
    })),
  };

  if (context.args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }

  console.log(`Surface Policies (${payload.envPath}):`);
  console.log('─'.repeat(100));
  for (const item of payload.surfaces) {
    console.log(`  ${formatSurfacePolicyHuman(item)}`);
    if (item.overrides.length > 0) {
      console.log(
        `    overrides: ${item.overrides.map((override) => `${override.setting}=${override.rawValue}`).join(', ')}`,
      );
    }
  }
  return true;
}

async function handleSurfacesCheck(context: CliContext, surface?: string): Promise<boolean> {
  if (!surface) {
    console.error('Usage: memphis config surfaces check <surface>');
    return true;
  }
  const policy = resolveSurfacePolicy(surface, process.env);
  const overrides = listSurfacePolicyOverrides(surface, process.env);
  const payload = {
    envPath: resolveDotEnvPath(process.env),
    surface: policy.surface,
    policy,
    overrides,
  };

  if (context.args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return true;
  }

  console.log(formatSurfacePolicyHuman(policy));
  if (overrides.length === 0) {
    console.log('  overrides: none');
  } else {
    for (const override of overrides) {
      console.log(`  override: ${override.setting}=${override.rawValue} (${override.envKey})`);
    }
  }
  return true;
}

async function handleSurfacesSet(
  context: CliContext,
  surface?: string,
  settingInput?: string,
): Promise<boolean> {
  if (!surface || !settingInput || !context.args.value) {
    console.error(
      'Usage: memphis config surfaces set <surface> <max-tool-tier|allow-url-fetch|allow-unknown-tools|allow-cognitive-prelude|allow-memory-recall|allow-memory-write|allow-operator-override> --value <...>',
    );
    return true;
  }

  const setting = normalizeSurfacePolicySettingName(settingInput);
  if (!setting) {
    console.error(`Unknown surface policy setting: ${settingInput}`);
    return true;
  }

  try {
    const value = parseSurfacePolicySettingValue(setting, context.args.value);
    const envKey = getSurfacePolicyEnvKey(surface, setting);
    const result = setDotEnvValues({ [envKey]: value }, process.env);
    process.env[envKey] = value;
    const policy = resolveSurfacePolicy(surface, process.env);

    if (context.args.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            envPath: result.path,
            updatedKeys: result.updatedKeys,
            surface: policy.surface,
            policy,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Updated ${envKey}=${value} in ${result.path}`);
      console.log(`Effective policy: ${formatSurfacePolicyHuman(policy)}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  }

  return true;
}

async function handleSurfacesReset(
  context: CliContext,
  surface?: string,
  settingInput?: string,
): Promise<boolean> {
  if (!surface) {
    console.error('Usage: memphis config surfaces reset <surface> [setting]');
    return true;
  }

  let keys: string[];
  if (settingInput) {
    const setting = normalizeSurfacePolicySettingName(settingInput);
    if (!setting) {
      console.error(`Unknown surface policy setting: ${settingInput}`);
      return true;
    }
    keys = [getSurfacePolicyEnvKey(surface, setting)];
  } else {
    keys = listSurfacePolicyOverrides(surface, process.env).map((item) => item.envKey);
  }

  if (keys.length === 0) {
    if (context.args.json) {
      console.log(
        JSON.stringify({ ok: true, removedKeys: [], envPath: resolveDotEnvPath(process.env) }),
      );
    } else {
      console.log(`No surface policy overrides found for ${surface}.`);
    }
    return true;
  }

  const result = unsetDotEnvValues(keys, process.env);
  for (const key of keys) {
    delete process.env[key];
  }
  const policy = resolveSurfacePolicy(surface, process.env);

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          envPath: result.path,
          removedKeys: result.removedKeys,
          surface: policy.surface,
          policy,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Removed ${result.removedKeys.length} override(s) from ${result.path}`);
    console.log(`Effective policy: ${formatSurfacePolicyHuman(policy)}`);
  }
  return true;
}

export const configCommandHandler: CommandHandler = {
  name: 'config',
  commands: ['config'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'config';
  },
  async handle(context: CliContext): Promise<boolean> {
    const sub = context.args.subcommand;

    if (sub === 'tools') {
      const action = context.args.target;
      const toolAction = action;
      const toolNameIdx = context.argv.indexOf(toolAction ?? '') + 1;
      const toolName = toolNameIdx > 0 ? context.argv[toolNameIdx] : undefined;
      const adjusted = { ...context, args: { ...context.args, target: toolName } };

      switch (toolAction) {
        case 'list':
          return handleToolsList(context);
        case 'allow':
          return handleToolsAllow(adjusted);
        case 'deny':
          return handleToolsDeny(adjusted);
        case 'set':
          return handleToolsSet(adjusted);
        case 'check':
          return handleToolsCheck(adjusted);
        case 'reset':
          return handleToolsReset(context);
        case 'pending':
          return handleToolsPending(context);
        case 'approve-call':
          return handleToolsApproveCall(adjusted);
        case 'deny-call':
          return handleToolsDenyCall(adjusted);
        default:
          console.error(
            'Usage: memphis config tools <list|allow|deny|set|check|reset|pending|approve-call|deny-call> [tool-name]',
          );
          return true;
      }
    }

    if (sub === 'surfaces') {
      const parsed = parseSurfaceCommandContext(context);
      switch (parsed.action) {
        case 'list':
          return handleSurfacesList(context, parsed.surface);
        case 'check':
          return handleSurfacesCheck(context, parsed.surface);
        case 'set':
          return handleSurfacesSet(context, parsed.surface, parsed.setting);
        case 'reset':
          return handleSurfacesReset(context, parsed.surface, parsed.setting);
        default:
          console.error(
            'Usage: memphis config surfaces <list|check|set|reset> [surface] [setting] [--value <...>]',
          );
          return true;
      }
    }

    console.error(
      'Usage: memphis config tools <list|allow|deny|set|check|reset|pending|approve-call|deny-call> [tool-name] | memphis config surfaces <list|check|set|reset> [surface] [setting]',
    );
    return true;
  },
};
