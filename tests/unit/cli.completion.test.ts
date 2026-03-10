import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';

describe('CLI completion', () => {
  it('prints bash completion script', () => {
    const out = execSync('npx tsx src/infra/cli/index.ts completion bash', { encoding: 'utf8' });
    expect(out).toContain('complete -F _memphis_completions memphis-v4');
    expect(out).toContain('--provider');
    expect(out).toContain('decentralized-llm');
  });

  it('prints zsh completion script', () => {
    const out = execSync('npx tsx src/infra/cli/index.ts completion zsh', { encoding: 'utf8' });
    expect(out).toContain('#compdef memphis memphis-v4');
    expect(out).toContain('bashcompinit');
  });

  it('prints fish completion script', () => {
    const out = execSync('npx tsx src/infra/cli/index.ts completion fish', { encoding: 'utf8' });
    expect(out).toContain('complete -c $c -f -n "__fish_use_subcommand"');
    expect(out).toContain('completion" -a "bash zsh fish');
  });
});
