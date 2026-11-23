/**
 * The gate between the commands the CLI dispatches and the ones the help
 * names.
 *
 * The registry (`src/infra/cli/registry.ts`) says WHICH commands exist. The
 * usage line (`src/infra/cli/command-usage.ts`) says what each one
 * accepts. Nothing compared them for a long time, so the line fell behind:
 * measured 2026-11-22 on this host, fifteen of the forty-three registered
 * commands were not in the help at all — `recovery` among them, which is
 * the command that resolves the turns the runtime left unsettled.
 *
 * A command the operator cannot find is a command the operator does not
 * have. This test is what makes the next one fail the build instead of
 * vanishing.
 */
import { describe, expect, it } from 'vitest';

import { buildCommandUsageLine, helpCommandStarters } from '../../src/infra/cli/command-usage.js';
import { CLI_COMMAND_REGISTRY } from '../../src/infra/cli/registry.js';

const usage = buildCommandUsageLine('auto');
const starters = helpCommandStarters(usage);

function commandsOf(entry: { commands: readonly (string | undefined)[] }): string[] {
  return entry.commands.filter((command): command is string => typeof command === 'string');
}

describe('the help names every command the CLI dispatches', () => {
  it('names every registered command group', () => {
    const undocumented = CLI_COMMAND_REGISTRY.filter(
      (entry) => !commandsOf(entry).some((command) => starters.has(command)),
    ).map((entry) => `${entry.name} (${commandsOf(entry).join(', ')})`);

    expect(
      undocumented,
      'these commands are dispatched but the help never names them — an operator cannot find what they cannot see',
    ).toEqual([]);
  });

  it('names every registered command, not just one of its aliases', () => {
    const missing = CLI_COMMAND_REGISTRY.flatMap((entry) =>
      commandsOf(entry)
        .filter((command) => !starters.has(command))
        .map((command) => `${entry.name}: ${command}`),
    );

    // The aliases of a documented command are covered by the canonical
    // name — `skill` by `skills`, `tensors` by `tensor`. They are the
    // commands the operator is not expected to type.
    const COVERED_BY_CANONICAL = new Set([
      'skill',
      'tensors',
      'insight',
      'self_governance',
      'classify',
      'suggest',
      'categorize',
      'providers:health',
      'help',
      '--help',
      'serve',
      'demo',
      'context',
      'workspace',
      'onboarding',
      'soul',
    ]);

    expect(
      missing.filter((entry) => {
        const command = entry.slice(entry.indexOf(': ') + 2);
        return !COVERED_BY_CANONICAL.has(command);
      }),
      'these commands are dispatched but never named in the help',
    ).toEqual([]);
  });

  it('keeps the line readable — no empty group, and every group starts with a word', () => {
    const groups = usage.split(' | ');
    expect(groups.every((group) => group.trim().length > 0)).toBe(true);
    expect(
      groups.every((group) => /^[A-Za-z][A-Za-z0-9:_-]*/.test(group.trim())),
      'every group must start with the name of a command',
    ).toBe(true);
  });
});
