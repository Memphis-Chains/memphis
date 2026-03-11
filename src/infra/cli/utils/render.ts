import { execSync } from 'node:child_process';

import chalk from 'chalk';

import type { CompletionShell } from '../types.js';

const CREATIVE_LOGOS = {
  small: `
   △⬡◈
  MEMPHIS
  `,
  medium: `
    ███╗   ███╗██╗   ██╗
    ████╗ ████║██║   ██║
    ██╔████╔██║██║   ██║
    ██║╚██╔╝██║██║   ██║
    ██║ ╚═╝ ██║╚██████╔╝
    ╚═╝     ╚═╝ ╚═════╝
    △⬡◈ Memphis v5
  `,
  large: `
    ███████╗██╗   ██╗███████╗████████╗██████╗  ██████╗ ████████╗
    ██╔════╝██║   ██║██╔════╝╚══██╔══╝██╔══██╗██╔═══██╗╚══██╔══╝
    ███████╗██║   ██║███████╗   ██║   ██████╔╝██║   ██║   ██║
    ╚════██║██║   ██║╚════██║   ██║   ██╔══██╗██║   ██║   ██║
    ███████║╚██████╔╝███████║   ██║   ██║  ██║╚██████╔╝   ██║
    ╚══════╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝    ╚═╝
                    △⬡◈ Memphis v5 — "OpenClaw executes. Memphis remembers."
  `,
} as const;

export function creativeBanner(text: string): string {
  const line = '═'.repeat(text.length + 4);
  return `╔${line}╗\n║  ${text}  ║\n╚${line}╝`;
}

export function renderRoadmapProgress(): string {
  const milestones = [
    { name: 'V5.1 Integration', progress: 82, status: 'complete' as const },
    { name: 'V5.2 Cognitive', progress: 64, status: 'in-progress' as const },
    { name: 'V5.3 Reflection', progress: 45, status: 'in-progress' as const },
    { name: 'V5.4 Production', progress: 25, status: 'pending' as const },
  ];

  const maxName = Math.max(...milestones.map((m) => m.name.length));
  const row = (progress: number): string => {
    const width = 12;
    const filled = Math.round((Math.max(0, Math.min(100, progress)) / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
  };

  return milestones
    .map((m) => {
      const emoji = m.status === 'complete' ? '✅' : m.status === 'in-progress' ? '🔄' : '⏳';
      const painter =
        m.status === 'complete'
          ? chalk.green
          : m.status === 'in-progress'
            ? chalk.yellow
            : chalk.gray;
      return painter(
        `${m.name.padEnd(maxName)}  ${row(m.progress)} ${String(m.progress).padStart(3)}% ${emoji}`,
      );
    })
    .join('\n');
}

export async function runCelebration(milestone: string): Promise<void> {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const progressBar = (value: number): string => {
    const width = 24;
    const filled = Math.round((Math.max(0, Math.min(100, value)) / 100) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${String(value).padStart(3)}%`;
  };

  process.stdout.write('\x1Bc');
  process.stdout.write(chalk.magenta.bold('△⬡◈ MEMPHIS MILESTONE CELEBRATION △⬡◈\n\n'));
  process.stdout.write(chalk.cyan(`Unlocked: ${milestone}\n\n`));

  for (let i = 0; i <= 100; i += 5) {
    process.stdout.write(`\r${chalk.yellow(progressBar(i))}`);
    await wait(35);
  }

  process.stdout.write('\n\n');
  process.stdout.write(chalk.green.bold('CONGRATULATIONS, CREATOR.\n'));
  process.stdout.write(chalk.white('OpenClaw executes. Memphis remembers.\n'));
  process.stdout.write('🔔✨🚀\n');
}

function generateBashCompletionScript(): string {
  return [
    '# bash completion for memphis',
    '_memphis_completions() {',
    '  local cur prev cmd sub',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  cmd="${COMP_WORDS[1]}"',
    '  sub="${COMP_WORDS[2]}"',
    '',
    '  case "${prev}" in',
    '    --provider)',
    '      COMPREPLY=( $(compgen -W "auto shared-llm decentralized-llm local-fallback" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --strategy)',
    '      COMPREPLY=( $(compgen -W "default latency-aware" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --to)',
    '      COMPREPLY=( $(compgen -W "proposed accepted implemented verified superseded rejected" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --profile)',
    '      COMPREPLY=( $(compgen -W "dev-local prod-shared prod-decentralized ollama-local" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    --size)',
    '      COMPREPLY=( $(compgen -W "small medium large" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '    completion)',
    '      COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") )',
    '      return 0',
    '      ;;',
    '  esac',
    '',
    '  if [[ ${COMP_CWORD} -eq 1 ]]; then',
    '    COMPREPLY=( $(compgen -W "setup configure init health reflect learn insights connections suggest serve providers:health providers models chat ask categorize decide infer agents relationships trust mcp debug tui doctor onboarding chain sync trade vault embed ascii progress celebrate completion help" -- "${cur}") )',
    '    return 0',
    '  fi',
    '',
    '  if [[ ${COMP_CWORD} -eq 2 ]]; then',
    '    case "${cmd}" in',
    '      providers) COMPREPLY=( $(compgen -W "list" -- "${cur}") ); return 0 ;;',
    '      models) COMPREPLY=( $(compgen -W "list" -- "${cur}") ); return 0 ;;',
    '      agents) COMPREPLY=( $(compgen -W "list discover show" -- "${cur}") ); return 0 ;;',
    '      relationships) COMPREPLY=( $(compgen -W "show" -- "${cur}") ); return 0 ;;',
    '      decide) COMPREPLY=( $(compgen -W "history transition" -- "${cur}") ); return 0 ;;',
    '      mcp) COMPREPLY=( $(compgen -W "serve serve-once serve-status serve-stop" -- "${cur}") ); return 0 ;;',
    '      onboarding) COMPREPLY=( $(compgen -W "wizard bootstrap" -- "${cur}") ); return 0 ;;',
    '      chain) COMPREPLY=( $(compgen -W "import_json rebuild" -- "${cur}") ); return 0 ;;',
    '      sync) COMPREPLY=( $(compgen -W "status push pull" -- "${cur}") ); return 0 ;;',
    '      trade) COMPREPLY=( $(compgen -W "offer accept" -- "${cur}") ); return 0 ;;',
    '      vault) COMPREPLY=( $(compgen -W "init add get list" -- "${cur}") ); return 0 ;;',
    '      embed) COMPREPLY=( $(compgen -W "store search reset" -- "${cur}") ); return 0 ;;',
    '      completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "${cur}") ); return 0 ;;',
    '      debug) COMPREPLY=( $(compgen -W "trace profile memory monitor" -- "${cur}") ); return 0 ;;',
    '    esac',
    '  fi',
    '',
    '  local flag_candidates="--json"',
    '  case "${cmd}" in',
    '    reflect|categorize) flag_candidates="--save --json" ;;',
    '    chat) flag_candidates="--input --provider --model --tui --interactive --strategy --json" ;;',
    '    ask) flag_candidates="--input --session --provider --model --tui --interactive --strategy --json" ;;',
    '    decide)',
    '      if [[ "${sub}" == "history" ]]; then',
    '        flag_candidates="--id --latest --json"',
    '      elif [[ "${sub}" == "transition" ]]; then',
    '        flag_candidates="--input --to --json"',
    '      else',
    '        flag_candidates="--input --to --latest --id --json"',
    '      fi',
    '      ;;',
    '    infer) flag_candidates="--input --json" ;;',
    '    mcp) flag_candidates="--input --schema --transport --port --duration-ms --json" ;;',
    '    ascii) flag_candidates="--size --json" ;;',
    '    progress|celebrate) flag_candidates="--json" ;;',
    '    setup|init) flag_candidates="--out --force --json" ;;',
    '    configure) flag_candidates="--non-interactive --dry-run --json" ;;',
    '    onboarding)',
    '      if [[ "${sub}" == "wizard" ]]; then',
    '        flag_candidates="--interactive --write --profile --out --force --json"',
    '      elif [[ "${sub}" == "bootstrap" ]]; then',
    '        flag_candidates="--profile --out --force --dry-run --apply --yes --json"',
    '      fi',
    '      ;;',
    '    chain)',
    '      if [[ "${sub}" == "import_json" ]]; then',
    '        flag_candidates="--file --write --confirm-write --out --json"',
    '      elif [[ "${sub}" == "rebuild" ]]; then',
    '        flag_candidates="--out --json"',
    '      fi',
    '      ;;',
    '    sync)',
    '      if [[ "${sub}" == "status" ]]; then flag_candidates="--chain --json";',
    '      elif [[ "${sub}" == "push" ]]; then flag_candidates="--chain --json";',
    '      elif [[ "${sub}" == "pull" ]]; then flag_candidates="--agent --chain --json"; fi',
    '      ;;',
    '    agents)',
    '      if [[ "${sub}" == "show" ]]; then flag_candidates="--id --json"; else flag_candidates="--json"; fi',
    '      ;;',
    '    trade)',
    '      if [[ "${sub}" == "offer" ]]; then flag_candidates="--recipient --blocks --file --json";',
    '      elif [[ "${sub}" == "accept" ]]; then flag_candidates="--offer-id --file --json"; fi',
    '      ;;',
    '    vault)',
    '      if [[ "${sub}" == "init" ]]; then flag_candidates="--passphrase --recovery-question --recovery-answer --json";',
    '      elif [[ "${sub}" == "add" ]]; then flag_candidates="--key --value --json";',
    '      else flag_candidates="--key --json"; fi',
    '      ;;',
    '    embed)',
    '      if [[ "${sub}" == "store" ]]; then flag_candidates="--id --value --json";',
    '      elif [[ "${sub}" == "search" ]]; then flag_candidates="--query --top-k --tuned --json"; fi',
    '      ;;',
    '    debug)',
    '      if [[ "${sub}" == "monitor" ]]; then flag_candidates="--interval --format --duration-ms --json";',
    '      elif [[ "${sub}" == "memory" ]]; then flag_candidates="--format --json";',
    '      else flag_candidates="--format --json"; fi',
    '      ;;',
    '    completion) return 0 ;;',
    '  esac',
    '',
    '  COMPREPLY=( $(compgen -W "${flag_candidates}" -- "${cur}") )',
    '  return 0',
    '}',
    'complete -F _memphis_completions memphis',
    'complete -F _memphis_completions memphis',
    '',
  ].join('\n');
}

function generateZshCompletionScript(): string {
  return [
    '#compdef memphis',
    'autoload -Uz bashcompinit',
    'bashcompinit',
    '',
    generateBashCompletionScript(),
  ].join('\n');
}

function generateFishCompletionScript(): string {
  return [
    '# fish completion for memphis',
    'for c in memphis',
    '  complete -c $c -f -n "__fish_use_subcommand" -a "setup configure init health reflect learn insights connections suggest serve providers:health providers models chat ask categorize decide infer agents relationships trust mcp debug tui doctor onboarding chain sync trade vault embed completion help"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from providers" -a "list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from models" -a "list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from agents" -a "list discover show"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from relationships" -a "show"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from decide" -a "history transition"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from mcp" -a "serve serve-once serve-status serve-stop"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from onboarding" -a "wizard bootstrap"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from chain" -a "import_json rebuild"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from sync" -a "status push pull"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from trade" -a "offer accept"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from vault" -a "init add get list"',
    '  complete -c $c -f -n "__fish_seen_subcommand_from embed" -a "store search reset"',
    '  complete -c $c -l json',
    '  complete -c $c -n "__fish_seen_subcommand_from reflect categorize" -l save',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l input',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l provider -a "auto shared-llm decentralized-llm local-fallback"',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l model',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l tui',
    '  complete -c $c -n "__fish_seen_subcommand_from ask" -l session',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l interactive',
    '  complete -c $c -n "__fish_seen_subcommand_from chat ask" -l strategy -a "default latency-aware"',
    '  complete -c $c -n "__fish_seen_subcommand_from decide infer mcp" -l input',
    '  complete -c $c -n "__fish_seen_subcommand_from decide" -l to -a "proposed accepted implemented verified superseded rejected"',
    '  complete -c $c -n "__fish_seen_subcommand_from decide history" -l id',
    '  complete -c $c -n "__fish_seen_subcommand_from decide history" -l latest',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l schema',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l transport -a "stdio http"',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l port',
    '  complete -c $c -n "__fish_seen_subcommand_from mcp" -l duration-ms',
    '  complete -c $c -n "__fish_seen_subcommand_from setup init" -l out',
    '  complete -c $c -n "__fish_seen_subcommand_from setup init" -l force',
    '  complete -c $c -n "__fish_seen_subcommand_from configure" -l non-interactive',
    '  complete -c $c -n "__fish_seen_subcommand_from configure" -l dry-run',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l profile -a "dev-local prod-shared prod-decentralized ollama-local"',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l out',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard bootstrap" -l force',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard" -l write',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding wizard" -l interactive',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l dry-run',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l apply',
    '  complete -c $c -n "__fish_seen_subcommand_from onboarding bootstrap" -l yes',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l file',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l write',
    '  complete -c $c -n "__fish_seen_subcommand_from chain import_json" -l confirm-write',
    '  complete -c $c -n "__fish_seen_subcommand_from vault add get list" -l key',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l passphrase',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l recovery-question',
    '  complete -c $c -n "__fish_seen_subcommand_from vault init" -l recovery-answer',
    '  complete -c $c -n "__fish_seen_subcommand_from vault add" -l value',
    '  complete -c $c -n "__fish_seen_subcommand_from embed store" -l id',
    '  complete -c $c -n "__fish_seen_subcommand_from embed store" -l value',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l query',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l top-k',
    '  complete -c $c -n "__fish_seen_subcommand_from embed search" -l tuned',
    'end',
    '',
  ].join('\n');
}

export function generateCompletionScript(shell: CompletionShell): string {
  if (shell === 'bash') return generateBashCompletionScript();
  if (shell === 'zsh') return generateZshCompletionScript();
  return generateFishCompletionScript();
}

export function print(data: unknown, asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (typeof data === 'object' && data !== null) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      console.log(`${k}: ${String(v)}`);
    }
    return;
  }

  console.log(String(data));
}

export function printChat(data: {
  id: string;
  providerUsed: string;
  modelUsed?: string;
  output: string;
  timingMs: number;
}): void {
  console.log(`id: ${data.id}`);
  console.log(`provider: ${data.providerUsed}`);
  if (data.modelUsed) console.log(`model: ${data.modelUsed}`);
  console.log(`timingMs: ${data.timingMs}`);
  console.log('---');
  console.log(data.output);
}

export function printProvidersHuman(
  items: Array<{ name: string; status: string; type: string }>,
): void {
  if (items.length === 0) {
    console.log('No providers configured');
    return;
  }

  for (const item of items) {
    console.log(`${item.name}  status=${item.status}  type=${item.type}`);
  }
}

export function printModelsHuman(
  items: Array<{
    provider: string;
    model: string;
    capabilities: { supports_streaming: boolean; supports_vision: boolean; context_window: number };
  }>,
): void {
  if (items.length === 0) {
    console.log('No models found for configured providers');
    return;
  }

  for (const item of items) {
    const caps = item.capabilities;
    console.log(
      `${item.provider}  ${item.model}  streaming=${caps.supports_streaming} vision=${caps.supports_vision} context=${caps.context_window}`,
    );
  }
}

export function printTuiAnswer(data: {
  providerUsed: string;
  output: string;
  trace?: {
    attempts: Array<{
      provider: string;
      ok: boolean;
      latencyMs: number;
      viaFallback: boolean;
      errorCode?: string;
    }>;
  };
}): void {
  const separator = '═'.repeat(48);
  console.log(`╔${separator}╗`);
  console.log(
    `║ memphis ask · provider=${data.providerUsed}${' '.repeat(Math.max(0, 16 - data.providerUsed.length))}║`,
  );
  if (data.trace) {
    const attempts = data.trace.attempts
      .map(
        (a) =>
          `${a.provider}:${a.ok ? 'ok' : (a.errorCode ?? 'err')}:${a.latencyMs}ms${a.viaFallback ? ':fb' : ''}`,
      )
      .join(' | ');
    const safe = attempts.length > 46 ? `${attempts.slice(0, 45)}…` : attempts;
    console.log(`║ trace ${safe.padEnd(40, ' ')} ║`);
  }
  console.log(`╠${separator}╣`);
  for (const line of data.output.split('\n')) {
    const safe = line.length > 46 ? `${line.slice(0, 45)}…` : line;
    console.log(`║ ${safe.padEnd(46, ' ')} ║`);
  }
  console.log(`╚${separator}╝`);
}

export function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

export function getCreativeLogo(size?: 'small' | 'medium' | 'large'): string {
  const validSizes: Array<keyof typeof CREATIVE_LOGOS> = ['small', 'medium', 'large'];
  const logoSize: keyof typeof CREATIVE_LOGOS = size && validSizes.includes(size) ? size : 'medium';
  return `${creativeBanner('MEMPHIS CREATIVE MODE')}\n${CREATIVE_LOGOS[logoSize]}`;
}
