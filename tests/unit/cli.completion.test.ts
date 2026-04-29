import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI completion', () => {
  it('prints bash completion script', async () => {
    const out = await runCli(['completion', 'bash']);
    expect(out).toContain('complete -F _memphis_completions memphis');
    expect(out).toContain('setup init workspace context apps skills health');
    expect(out).not.toContain('setup configure init workspace context apps skills health');
    expect(out).toContain('service deploy reset');
    expect(out).toContain(
      'skills) COMPREPLY=( $(compgen -W "list show install create validate import"',
    );
    expect(out).toContain('--provider');
    expect(out).toContain('tui) flag_candidates="--check-only --json --run-command"');
    expect(out).toContain('setup) COMPREPLY=( $(compgen -W "status telegram"');
    expect(out).toContain('init) COMPREPLY=( $(compgen -W "status"');
    expect(out).toContain('deploy) COMPREPLY=( $(compgen -W "run health rollback"');
    expect(out).toContain(
      'init) flag_candidates="--state --non-interactive --operator-passphrase --passphrase --recovery-question --recovery-answer --json"',
    );
    expect(out).toContain('decentralized-llm');
    expect(out).toContain('minimax');
    expect(out).toContain('deepseek');
    expect(out).toContain('glm');
    expect(out).toContain(
      'service) COMPREPLY=( $(compgen -W "status install logs restart uninstall"',
    );
  });

  it('prints zsh completion script', async () => {
    const out = await runCli(['completion', 'zsh']);
    expect(out).toContain('#compdef memphis');
    expect(out).toContain('bashcompinit');
  });

  it('prints fish completion script', async () => {
    const out = await runCli(['completion', 'fish']);
    expect(out).toContain('complete -c $c -f -n "__fish_use_subcommand"');
    expect(out).toContain('completion" -a "bash zsh fish');
    expect(out).toContain('__fish_seen_subcommand_from service');
    expect(out).toContain('__fish_seen_subcommand_from skills');
    expect(out).toContain('__fish_seen_subcommand_from deploy');
    expect(out).toContain('__fish_seen_subcommand_from reset');
    expect(out).toContain('__fish_seen_subcommand_from tui" -l check-only');
    expect(out).toContain('__fish_seen_subcommand_from setup" -a "status telegram"');
    expect(out).toContain('__fish_seen_subcommand_from setup init" -l state');
    expect(out).toContain(
      'shared-llm decentralized-llm local-fallback ollama minimax deepseek glm',
    );
  });
});
