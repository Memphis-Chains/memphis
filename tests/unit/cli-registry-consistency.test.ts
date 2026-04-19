/**
 * Guard against the kind of CLI dispatch drift that produced the
 * `Unknown command: self-update` regression after Sprint 14.
 *
 * Sprint 14 added `memphis self-update check` and wired the handler in
 * `src/infra/cli/handlers/system.handler.ts`, but the dispatcher's
 * `CLI_COMMAND_REGISTRY` didn't list the command name — so the
 * top-level routing fell through and the command was unreachable.
 * This test asserts the three lists stay in lockstep:
 *
 * 1. Every command name in `CLI_COMMAND_REGISTRY` is either listed in
 *    `CLI_COMPLETION_COMMANDS` or explicitly excluded via
 *    `CLI_NON_COMPLETABLE_COMMANDS`.
 * 2. Every entry in `CLI_COMPLETION_COMMANDS` resolves to a registered
 *    handler in `CLI_COMMAND_REGISTRY`.
 * 3. Each registration's commands are unique within itself (no
 *    accidental duplicates).
 */

import { describe, expect, it } from 'vitest';

import {
  CLI_COMMAND_REGISTRY,
  CLI_COMPLETION_COMMANDS,
  CLI_NON_COMPLETABLE_COMMANDS,
  getCliCommandRegistrations,
} from '../../src/infra/cli/registry.js';

function collectAllRegisteredCommands(): Set<string | undefined> {
  const all = new Set<string | undefined>();
  for (const reg of CLI_COMMAND_REGISTRY) {
    for (const cmd of reg.commands) all.add(cmd);
  }
  return all;
}

describe('CLI registry ↔ completion list consistency', () => {
  it('every dispatcher-routed command is in completion or explicitly excluded', () => {
    const completion = new Set<string>(CLI_COMPLETION_COMMANDS);
    const missing: string[] = [];
    for (const cmd of collectAllRegisteredCommands()) {
      if (CLI_NON_COMPLETABLE_COMMANDS.has(cmd)) continue;
      if (cmd === undefined) continue;
      if (!completion.has(cmd)) missing.push(cmd);
    }
    expect(missing.sort()).toEqual([]);
  });

  it('every completion entry resolves to a registered handler', () => {
    const orphans: string[] = [];
    for (const cmd of CLI_COMPLETION_COMMANDS) {
      const registrations = getCliCommandRegistrations(cmd);
      if (registrations.length === 0) orphans.push(cmd);
    }
    expect(orphans.sort()).toEqual([]);
  });

  it('non-completable exclusions actually exist as routed commands', () => {
    // Catches stale exclusions for commands that no longer exist.
    const all = collectAllRegisteredCommands();
    const stale: string[] = [];
    for (const excluded of CLI_NON_COMPLETABLE_COMMANDS) {
      if (excluded === undefined) continue;
      if (!all.has(excluded)) stale.push(excluded);
    }
    expect(stale).toEqual([]);
  });

  it('each registration has unique commands (no accidental duplicates)', () => {
    const offenders: Array<{ name: string; duplicates: string[] }> = [];
    for (const reg of CLI_COMMAND_REGISTRY) {
      const seen = new Map<string | undefined, number>();
      for (const cmd of reg.commands) {
        seen.set(cmd, (seen.get(cmd) ?? 0) + 1);
      }
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => String(name));
      if (dupes.length > 0) offenders.push({ name: reg.name, duplicates: dupes });
    }
    expect(offenders).toEqual([]);
  });

  it('two registrations never claim the same command (would race the dispatcher)', () => {
    const collisions: Array<{ command: string | undefined; owners: string[] }> = [];
    const claims = new Map<string | undefined, string[]>();
    for (const reg of CLI_COMMAND_REGISTRY) {
      for (const cmd of reg.commands) {
        const owners = claims.get(cmd) ?? [];
        owners.push(reg.name);
        claims.set(cmd, owners);
      }
    }
    for (const [command, owners] of claims) {
      if (owners.length > 1) collisions.push({ command, owners });
    }
    expect(collisions).toEqual([]);
  });
});

describe('Sprint additions reachable through the dispatcher', () => {
  it.each([
    ['self-update', 'system', 'Sprint 14'],
    ['backup', 'system', 'Sprint 8 (--pepper-restore)'],
    ['chain', 'storage', 'Sprint 12 (verify)'],
    ['vault', 'vault', 'Sprint 1 (pepper-rotate, master-key-rotate, etc.)'],
    ['audit', 'audit', 'Sprint 1 (search)'],
    ['provider', 'provider', 'Sprint 1/3 (provider add)'],
    ['mcp', 'mcp', 'Sprint 7 (memphis_presence, memphis_config_*)'],
    ['telegram', 'telegram', 'Sprint 9 (/voice via Telegram bot)'],
    ['restart', 'system', 'Sprint: self-restart'],
  ] as const)('`memphis %s` resolves through the %s registration (%s)', (cmd, expectedHandler) => {
    const registrations = getCliCommandRegistrations(cmd);
    expect(registrations.length).toBeGreaterThanOrEqual(1);
    expect(registrations.map((r) => r.name)).toContain(expectedHandler);
  });
});
