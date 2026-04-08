import { describe, expect, it } from 'vitest';

import {
  getCliCommandRegistrations,
  listCliCompletionCommands,
} from '../../src/infra/cli/registry.js';

describe('CLI command registry', () => {
  it('maps top-level commands to the owning lazy handler registrations', () => {
    expect(getCliCommandRegistrations('ask').map((entry) => entry.name)).toEqual(['interaction']);
    expect(getCliCommandRegistrations('deploy').map((entry) => entry.name)).toEqual(['system']);
    expect(getCliCommandRegistrations('chain').map((entry) => entry.name)).toEqual(['storage']);
    expect(getCliCommandRegistrations('unknown-command')).toEqual([]);
  });

  it('exposes the discoverable completion surface from one centralized list', () => {
    const commands = listCliCompletionCommands();

    expect(commands).toContain('setup');
    expect(commands).toContain('apps');
    expect(commands).toContain('providers:health');
    expect(commands).toContain('guide');
    expect(commands).not.toContain('auth');
    expect(commands).not.toContain('config');
  });

  it('loads handlers lazily from the central registry', async () => {
    const [registration] = getCliCommandRegistrations('explain');
    expect(registration).toBeDefined();

    const handler = await registration!.loadHandler();

    expect(handler.name).toBe('explain');
    expect(handler.commands).toEqual(['explain']);
  });
});
