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

/**
 * Commands that accept a free-text question as the bulk argument. For these,
 * if --input is not given we join `positionals[1..]` into a single string so
 * `memphis ask co jest` works the same as `memphis ask --input "co jest"`.
 *
 * Why: operator memory feedback — typing `--input X` for every chat is
 * friction. The natural shell shape is `memphis ask <words>`. The current
 * parser dropped that shape and threw "Missing required --input".
 *
 * `--input` still wins when given (operator can override a positional with
 * an explicit flag). Subcommand-style commands (`ask-session`, `chat`
 * subcommands) are not in this set; they still need explicit --input.
 */
const POSITIONAL_INPUT_COMMANDS = new Set(['ask', 'chat']);

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

  const inputFlag = readFlagValue(flags, '--input');
  const positionalInput =
    inputFlag === undefined &&
    positionals[0] !== undefined &&
    POSITIONAL_INPUT_COMMANDS.has(positionals[0])
      ? positionals.slice(1).join(' ').trim() || undefined
      : undefined;

  return {
    command: positionals[0],
    // For positional-input commands the words after the verb are the
    // question, not a subcommand/target. Suppress sub/target so the
    // handlers don't try to interpret them.
    subcommand: positionalInput !== undefined ? undefined : positionals[1],
    target: positionalInput !== undefined ? undefined : positionals[2],
    json: hasBooleanFlag(flags, '--json'),
    checkOnly: hasBooleanFlag(flags, '--check-only'),
    runCommand: readFlagValue(flags, '--run-command'),
    stdioJson: hasBooleanFlag(flags, '--stdio-json'),
    tui: hasBooleanFlag(flags, '--tui'),
    write: hasBooleanFlag(flags, '--write'),
    save: hasBooleanFlag(flags, '--save'),
    input: inputFlag ?? positionalInput,
    session: readFlagValue(flags, '--session'),
    provider: readFlagValue(flags, '--provider') as CliArgs['provider'],
    model: readFlagValue(flags, '--model'),
    file: readFlagValue(flags, '--file'),
    out: readFlagValue(flags, '--out'),
    buildCommand: readFlagValue(flags, '--build-command'),
    deployCommand: readFlagValue(flags, '--deploy-command'),
    healthUrl: readFlagValue(flags, '--health-url'),
    testSuite: readFlagValue(flags, '--test-suite'),
    confirmWrite: hasBooleanFlag(flags, '--confirm-write'),
    confirm: hasBooleanFlag(flags, '--confirm'),
    key: readFlagValue(flags, '--key'),
    value: readFlagValue(flags, '--value'),
    name: readFlagValue(flags, '--name'),
    description: readFlagValue(flags, '--description'),
    tools: readFlagValue(flags, '--tools'),
    topic: readFlagValue(flags, '--topic'),
    source: readFlagValue(flags, '--source'),
    passphrase: readFlagValue(flags, '--passphrase'),
    operatorPassphrase: readFlagValue(flags, '--operator-passphrase'),
    recoveryQuestion: readFlagValue(flags, '--recovery-question'),
    recoveryAnswer: readFlagValue(flags, '--recovery-answer'),
    id: readFlagValue(flags, '--id'),
    query: readFlagValue(flags, '--query'),
    register: hasBooleanFlag(flags, '--register'),
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
    noVault: hasBooleanFlag(flags, '--no-vault'),
    fix: hasBooleanFlag(flags, '--fix'),
    deep: hasBooleanFlag(flags, '--deep'),
    cron: hasBooleanFlag(flags, '--cron'),
    // Accept both --cron-pattern (verbose) and --cron VALUE (short alias).
    // Operators reach for --cron naturally; the help text used --cron
    // historically while the parser only read --cron-pattern, so every
    // example failed silently. Boolean --cron flag (used by `memphis health
    // --cron`) keeps working — readFlagValue requires a non-flag token after
    // the flag name, so `health --cron` (no value) still parses as boolean.
    cronPattern: readFlagValue(flags, '--cron-pattern') ?? readFlagValue(flags, '--cron'),
    apply: hasBooleanFlag(flags, '--apply'),
    dryRun: hasBooleanFlag(flags, '--dry-run'),
    consent: readFlagValue(flags, '--consent'),
    skipRestart: hasBooleanFlag(flags, '--skip-restart'),
    skipBuild: hasBooleanFlag(flags, '--skip-build'),
    allowAllUsers: hasBooleanFlag(flags, '--allow-all-users'),
    yes: hasBooleanFlag(flags, '--yes'),
    schema: hasBooleanFlag(flags, '--schema'),
    verbose: hasBooleanFlag(flags, '--verbose'),
    maxTokens: readNumberFlag(flags, '--max-tokens'),
    contextWindow: readNumberFlag(flags, '--context-window'),
    temperature: readNumberFlag(flags, '--temperature'),
    systemPrompt: readFlagValue(flags, '--system-prompt'),
    // Accept --task-type (verbose) and --type (short alias). Memphis
    // schedule examples always used --type; parser previously only matched
    // --task-type, so every example failed silently.
    taskType: (readFlagValue(flags, '--task-type') ?? readFlagValue(flags, '--type')) as CliArgs['taskType'],
    priority: readFlagValue(flags, '--priority') as CliArgs['priority'],
    minContext: readNumberFlag(flags, '--min-context'),
    vision: hasBooleanFlag(flags, '--vision'),
    functions: hasBooleanFlag(flags, '--functions'),
    size: readFlagValue(flags, '--size') as CliArgs['size'],
    reset: hasBooleanFlag(flags, '--reset'),
    runtime: hasBooleanFlag(flags, '--runtime'),
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
    limit: readNumberFlag(flags, '--limit'),
    safeMode: hasBooleanFlag(flags, '--safe-mode'),
    strictMode: hasBooleanFlag(flags, '--strict-mode'),
    telegram: hasBooleanFlag(flags, '--telegram'),
    faultInject: readFlagValue(flags, '--fault-inject'),
    state: readFlagValue(flags, '--state'),
    action: readFlagValue(flags, '--action'),
    limits: readFlagValue(flags, '--limits'),
    since: readFlagValue(flags, '--since'),
    until: readFlagValue(flags, '--until'),
    contains: readFlagValue(flags, '--contains'),
    status: readFlagValue(flags, '--status'),
    providerOnly: hasBooleanFlag(flags, '--provider-only'),
    serverName: readFlagValue(flags, '--server-name'),
    adminUser: readFlagValue(flags, '--admin-user'),
    adminPass: readFlagValue(flags, '--admin-pass'),
    apiKey: readFlagValue(flags, '--api-key'),
    botToken: readFlagValue(flags, '--bot-token'),
    allowedUserIds: readFlagValue(flags, '--allowed-user-ids'),
    pepperRestore: readFlagValue(flags, '--pepper-restore'),
    level: readFlagValue(flags, '--level'),
    fromIndex: readNumberFlag(flags, '--from-index'),
  };
}
