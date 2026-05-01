import type { CommandHandler } from './command-handler.js';
import { getToolNames } from '../../../gateway/tool-registry.js';
import { ensureSoulManifest, writeSoulManifest } from '../../../soul/manifest.js';
import type { AutonomyMode, TrustRule } from '../../../soul/types.js';
import { requireOperatorAuth } from '../../auth/operator-gate.js';
import type { CliContext } from '../context.js';

const VALID_MODES: AutonomyMode[] = ['full', 'quiet', 'balanced', 'paranoid'];

async function handleTrustList(context: CliContext): Promise<boolean> {
  const manifest = ensureSoulManifest();
  const rules = manifest.trustRules ?? [];

  if (context.args.json) {
    console.log(JSON.stringify({ mode: manifest.mode, trustRules: rules }, null, 2));
    return true;
  }

  console.log(`Autonomy mode: ${manifest.mode}`);
  console.log('');
  if (rules.length === 0) {
    console.log('No trust rules configured.');
    console.log('Use "memphis trust add <tool> --auto-approve" to add a rule.');
  } else {
    console.log('Trust Rules:');
    console.log('─'.repeat(60));
    for (const rule of rules) {
      const icon = rule.autoApprove ? '✓' : '⚠';
      const label = rule.autoApprove ? 'auto-approve' : 'require-approval';
      console.log(`  ${icon} ${rule.tool.padEnd(30)} ${label}`);
    }
    console.log('─'.repeat(60));
    console.log(`${String(rules.length)} rule(s) configured.`);
  }
  return true;
}

async function handleTrustAdd(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  if (!toolName) {
    console.error('Usage: memphis trust add <tool> [--auto-approve]');
    return true;
  }

  // S5-1: gate before mutating manifest. Tool-permission rules
  // change which tier-2 tools auto-approve — destructive auth state.
  if (!(await requireOperatorAuth())) {
    throw new Error('Operator authentication failed.');
  }

  // Validate tool name (allow '*' wildcard)
  const knownTools = getToolNames(process.env);
  if (toolName !== '*' && !knownTools.includes(toolName)) {
    console.error(`Unknown tool: ${toolName}`);
    console.error(`Known tools: ${knownTools.join(', ')}`);
    return true;
  }

  const manifest = ensureSoulManifest(process.env);
  const rules = manifest.trustRules ?? [];

  // Remove existing rule for this tool if any
  const filtered = rules.filter((r) => r.tool !== toolName);

  const autoApprove = context.argv.includes('--auto-approve');

  const newRule: TrustRule = {
    tool: toolName,
    autoApprove,
    addedAt: new Date().toISOString(),
  };

  manifest.trustRules = [...filtered, newRule];
  writeSoulManifest(manifest);

  if (context.args.json) {
    console.log(JSON.stringify({ added: newRule }, null, 2));
  } else {
    const label = autoApprove ? 'auto-approve' : 'require-approval';
    console.log(`Trust rule added: ${toolName} → ${label}`);
  }
  return true;
}

async function handleTrustRemove(context: CliContext): Promise<boolean> {
  const toolName = context.args.target;
  if (!toolName) {
    console.error('Usage: memphis trust remove <tool>');
    return true;
  }

  // S5-1: gate before mutating manifest.
  if (!(await requireOperatorAuth())) {
    throw new Error('Operator authentication failed.');
  }

  const manifest = ensureSoulManifest();
  const rules = manifest.trustRules ?? [];
  const before = rules.length;

  manifest.trustRules = rules.filter((r) => r.tool !== toolName);
  writeSoulManifest(manifest);

  const removed = before - manifest.trustRules.length;

  if (context.args.json) {
    console.log(JSON.stringify({ removed: removed > 0, tool: toolName }, null, 2));
  } else if (removed > 0) {
    console.log(`Trust rule removed: ${toolName}`);
  } else {
    console.log(`No trust rule found for: ${toolName}`);
  }
  return true;
}

async function handleTrustMode(context: CliContext): Promise<boolean> {
  const manifest = ensureSoulManifest();

  // If target is 'set', the actual mode value is in the remaining argv
  if (context.args.subcommand === 'mode' && context.args.target === 'set') {
    const modeArg = context.argv[3] as string | undefined;
    if (!modeArg || !VALID_MODES.includes(modeArg as AutonomyMode)) {
      console.error(`Usage: memphis trust mode set <${VALID_MODES.join('|')}>`);
      return true;
    }

    // S5-1: gate before flipping autonomy mode (full unblocks every
    // tier-2 tool by default — operator decision, not silent).
    if (!(await requireOperatorAuth())) {
      throw new Error('Operator authentication failed.');
    }

    manifest.mode = modeArg as AutonomyMode;
    writeSoulManifest(manifest);

    if (context.args.json) {
      console.log(JSON.stringify({ mode: manifest.mode }, null, 2));
    } else {
      console.log(`Autonomy mode set to: ${manifest.mode}`);
    }
    return true;
  }

  // Show current mode
  if (context.args.json) {
    console.log(JSON.stringify({ mode: manifest.mode }, null, 2));
  } else {
    console.log(`Autonomy mode: ${manifest.mode}`);
    console.log('');
    console.log('Modes:');
    console.log('  full     — all tiers auto-allow (tier-3 elevation sets this for 3h)');
    console.log('  quiet    — tier0 + tier1 auto-allow, tier2 requires approval');
    console.log('  balanced — tier0 auto-allow, tier1 + tier2 require approval (default)');
    console.log('  paranoid — all tools require approval');
    console.log('');
    console.log(`Use "memphis trust mode set <${VALID_MODES.join('|')}>" to change.`);
  }
  return true;
}

async function handleTrustCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;

  if (sub === 'list' || !sub) {
    return handleTrustList(context);
  }
  if (sub === 'add') {
    return handleTrustAdd(context);
  }
  if (sub === 'remove') {
    return handleTrustRemove(context);
  }
  if (sub === 'mode') {
    return handleTrustMode(context);
  }

  console.error(`Unknown trust subcommand: ${sub}`);
  console.error('Usage: memphis trust <list|add|remove|mode> [options]');
  return true;
}

export const trustCommandHandler: CommandHandler = {
  name: 'trust',
  commands: ['trust'],
  canHandle: (context: CliContext) => context.args.command === 'trust',
  handle: handleTrustCommand,
};
