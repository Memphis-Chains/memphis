/**
 * Verifies `memphis ask <words>` is accepted as the natural shape for a
 * chat question — no `--input` flag required.
 *
 * Operator log 2026-04-26:
 *   memphis ask co jest  →  Error: Missing required --input
 *
 * The fix: when command is in POSITIONAL_INPUT_COMMANDS and --input is
 * absent, join positionals[1..] as the input. --input still wins when
 * given so explicit operators can override.
 */

import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../src/infra/cli/parser.js';

describe('memphis ask — positional input fallback', () => {
  it('joins multi-word positionals after `ask` into a single input', () => {
    const args = parseCommand(['node', 'cli', 'ask', 'co', 'jest']);
    expect(args.command).toBe('ask');
    expect(args.input).toBe('co jest');
    expect(args.subcommand).toBeUndefined();
    expect(args.target).toBeUndefined();
  });

  it('accepts a single quoted positional as input', () => {
    const args = parseCommand(['node', 'cli', 'ask', 'co jest']);
    expect(args.input).toBe('co jest');
  });

  it('lets explicit --input override the positional fallback', () => {
    const args = parseCommand([
      'node',
      'cli',
      'ask',
      '--input',
      'X',
      'ignored',
      'positional',
    ]);
    expect(args.input).toBe('X');
  });

  it('also works for `chat`', () => {
    const args = parseCommand(['node', 'cli', 'chat', 'hello', 'world']);
    expect(args.command).toBe('chat');
    expect(args.input).toBe('hello world');
  });

  it('does NOT consume positionals for non-chat commands', () => {
    // `memphis vault add foo` — `add` is the subcommand, `foo` the target.
    const args = parseCommand(['node', 'cli', 'vault', 'add', 'foo']);
    expect(args.command).toBe('vault');
    expect(args.subcommand).toBe('add');
    expect(args.target).toBe('foo');
    expect(args.input).toBeUndefined();
  });

  it('returns undefined input when ask has no positional and no --input', () => {
    const args = parseCommand(['node', 'cli', 'ask']);
    expect(args.command).toBe('ask');
    expect(args.input).toBeUndefined();
  });
});
