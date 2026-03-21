import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI completion', () => {
  it('prints bash completion script', async () => {
    const out = await runCli(['completion', 'bash']);
    expect(out).toContain('complete -F _memphis_completions memphis');
    expect(out).toContain('setup configure init workspace context apps health');
    expect(out).toContain('service reset');
    expect(out).toContain('--provider');
    expect(out).toContain('decentralized-llm');
    expect(out).toContain('service) COMPREPLY=( $(compgen -W "status install logs restart uninstall"');
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
    expect(out).toContain('__fish_seen_subcommand_from reset');
  });
});
