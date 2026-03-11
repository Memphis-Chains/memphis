import type { CliArgs } from './types.js';

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

  const readFlag = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };

  const hasFlag = (name: string): boolean => flags.get(name) === true;

  return {
    command: positionals[0],
    subcommand: positionals[1],
    target: positionals[2],
    json: hasFlag('--json'),
    tui: hasFlag('--tui'),
    write: hasFlag('--write'),
    save: hasFlag('--save'),
    input: readFlag('--input'),
    session: readFlag('--session'),
    provider: readFlag('--provider') as CliArgs['provider'],
    model: readFlag('--model'),
    file: readFlag('--file'),
    out: readFlag('--out'),
    confirmWrite: hasFlag('--confirm-write'),
    key: readFlag('--key'),
    value: readFlag('--value'),
    passphrase: readFlag('--passphrase'),
    recoveryQuestion: readFlag('--recovery-question'),
    recoveryAnswer: readFlag('--recovery-answer'),
    id: readFlag('--id'),
    query: readFlag('--query'),
    to: readFlag('--to'),
    latest: readFlag('--latest') ? Number(readFlag('--latest')) : undefined,
    port: readFlag('--port') ? Number(readFlag('--port')) : undefined,
    transport: readFlag('--transport') as CliArgs['transport'],
    durationMs: readFlag('--duration-ms') ? Number(readFlag('--duration-ms')) : undefined,
    topK: readFlag('--top-k') ? Number(readFlag('--top-k')) : undefined,
    tuned: hasFlag('--tuned'),
    strategy: readFlag('--strategy') as CliArgs['strategy'],
    interactive: hasFlag('--interactive'),
    nonInteractive: hasFlag('--non-interactive'),
    profile: readFlag('--profile') as CliArgs['profile'],
    force: hasFlag('--force'),
    fix: hasFlag('--fix'),
    deep: hasFlag('--deep'),
    apply: hasFlag('--apply'),
    dryRun: hasFlag('--dry-run'),
    yes: hasFlag('--yes'),
    schema: hasFlag('--schema'),
    verbose: hasFlag('--verbose'),
    maxTokens: readFlag('--max-tokens') ? Number(readFlag('--max-tokens')) : undefined,
    contextWindow: readFlag('--context-window') ? Number(readFlag('--context-window')) : undefined,
    temperature: readFlag('--temperature') ? Number(readFlag('--temperature')) : undefined,
    systemPrompt: readFlag('--system-prompt'),
    taskType: readFlag('--task-type') as CliArgs['taskType'],
    priority: readFlag('--priority') as CliArgs['priority'],
    minContext: readFlag('--min-context') ? Number(readFlag('--min-context')) : undefined,
    vision: hasFlag('--vision'),
    functions: hasFlag('--functions'),
    size: readFlag('--size') as CliArgs['size'],
    reset: hasFlag('--reset'),
    chain: readFlag('--chain'),
    cid: readFlag('--cid'),
    recipient: readFlag('--recipient'),
    blocks: readFlag('--blocks'),
    offerId: readFlag('--offer-id'),
    days: readFlag('--days') ? Number(readFlag('--days')) : undefined,
    repoPath: readFlag('--repo-path'),
    agent: readFlag('--agent'),
    list: hasFlag('--list'),
    clean: hasFlag('--clean'),
    restore: readFlag('--restore'),
    keep: readFlag('--keep') ? Number(readFlag('--keep')) : undefined,
    tag: readFlag('--tag'),
  };
}
