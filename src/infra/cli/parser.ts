import type { CliArgs } from './types.js';

function readFlagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

function hasBooleanFlag(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}

function readNumberFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const value = readFlagValue(flags, name);
  return value ? Number(value) : undefined;
}

export function parseCommand(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      flags.set(token, true);
      continue;
    }

    flags.set(token, next);
    i += 1;
  }

  return {
    command: positionals[0],
    subcommand: positionals[1],
    target: positionals[2],
    json: hasBooleanFlag(flags, '--json'),
    tui: hasBooleanFlag(flags, '--tui'),
    write: hasBooleanFlag(flags, '--write'),
    save: hasBooleanFlag(flags, '--save'),
    input: readFlagValue(flags, '--input'),
    session: readFlagValue(flags, '--session'),
    provider: readFlagValue(flags, '--provider') as CliArgs['provider'],
    model: readFlagValue(flags, '--model'),
    file: readFlagValue(flags, '--file'),
    out: readFlagValue(flags, '--out'),
    confirmWrite: hasBooleanFlag(flags, '--confirm-write'),
    key: readFlagValue(flags, '--key'),
    value: readFlagValue(flags, '--value'),
    passphrase: readFlagValue(flags, '--passphrase'),
    recoveryQuestion: readFlagValue(flags, '--recovery-question'),
    recoveryAnswer: readFlagValue(flags, '--recovery-answer'),
    id: readFlagValue(flags, '--id'),
    query: readFlagValue(flags, '--query'),
    to: readFlagValue(flags, '--to'),
    latest: readNumberFlag(flags, '--latest'),
    port: readNumberFlag(flags, '--port'),
    transport: readFlagValue(flags, '--transport') as CliArgs['transport'],
    durationMs: readNumberFlag(flags, '--duration-ms'),
    topK: readNumberFlag(flags, '--top-k'),
    tuned: hasBooleanFlag(flags, '--tuned'),
    strategy: readFlagValue(flags, '--strategy') as CliArgs['strategy'],
    interactive: hasBooleanFlag(flags, '--interactive'),
    nonInteractive: hasBooleanFlag(flags, '--non-interactive'),
    profile: readFlagValue(flags, '--profile') as CliArgs['profile'],
    force: hasBooleanFlag(flags, '--force'),
    fix: hasBooleanFlag(flags, '--fix'),
    deep: hasBooleanFlag(flags, '--deep'),
    apply: hasBooleanFlag(flags, '--apply'),
    dryRun: hasBooleanFlag(flags, '--dry-run'),
    yes: hasBooleanFlag(flags, '--yes'),
    schema: hasBooleanFlag(flags, '--schema'),
    verbose: hasBooleanFlag(flags, '--verbose'),
    maxTokens: readNumberFlag(flags, '--max-tokens'),
    contextWindow: readNumberFlag(flags, '--context-window'),
    temperature: readNumberFlag(flags, '--temperature'),
    systemPrompt: readFlagValue(flags, '--system-prompt'),
    taskType: readFlagValue(flags, '--task-type') as CliArgs['taskType'],
    priority: readFlagValue(flags, '--priority') as CliArgs['priority'],
    minContext: readNumberFlag(flags, '--min-context'),
    vision: hasBooleanFlag(flags, '--vision'),
    functions: hasBooleanFlag(flags, '--functions'),
    size: readFlagValue(flags, '--size') as CliArgs['size'],
    reset: hasBooleanFlag(flags, '--reset'),
    chain: readFlagValue(flags, '--chain'),
    cid: readFlagValue(flags, '--cid'),
    recipient: readFlagValue(flags, '--recipient'),
    blocks: readFlagValue(flags, '--blocks'),
    offerId: readFlagValue(flags, '--offer-id'),
    days: readNumberFlag(flags, '--days'),
    repoPath: readFlagValue(flags, '--repo-path'),
    agent: readFlagValue(flags, '--agent'),
    list: hasBooleanFlag(flags, '--list'),
    clean: hasBooleanFlag(flags, '--clean'),
    restore: readFlagValue(flags, '--restore'),
    keep: readNumberFlag(flags, '--keep'),
    tag: readFlagValue(flags, '--tag'),
    format: readFlagValue(flags, '--format') as CliArgs['format'],
    intervalMs: readNumberFlag(flags, '--interval'),
  };
}
