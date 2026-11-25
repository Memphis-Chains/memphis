/**
 * The CLI parser — a flag in front of the command must not eat it.
 *
 * ## Why this gate exists
 *
 * The parser decided "does this flag take a value?" by looking at the
 * NEXT token. A boolean flag in front of the command therefore claimed
 * the command as its value, and the command was never run.
 *
 * Measured on the operator's host (2026-11-23):
 *
 * ```text
 * $ memphis --safe-mode health --json
 * ... usage guide, exit 0        <- health never ran, safe mode was OFF
 * ```
 *
 * The operator asked for a safe-mode health check and got a usage
 * guide. The safety switch was silently a no-op, and the exit code
 * said "fine".
 *
 * ## The rule the gate pins
 *
 * - a flag in `BOOLEAN_FLAGS` is boolean and never consumes the next
 *   token;
 * - a flag outside it keeps the old "the next token is probably its
 *   value" behaviour;
 * - `--cron` is both, and keeps both shapes working;
 * - the exported list and the flags the parser actually reads as
 *   boolean cannot drift apart.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BOOLEAN_FLAGS, parseCommand } from '../../src/infra/cli/parser.js';

const PARSER_SOURCE = 'src/infra/cli/parser.ts';

/**
 * The flags the parser reads as boolean, taken from the source.
 *
 * Read from the file rather than duplicated here: a second copy of the
 * list in the test would drift from the one in the parser, and the gate
 * would keep passing while the parser kept eating commands.
 */
function booleanFlagsReadByTheParser(): string[] {
  const source = readFileSync(PARSER_SOURCE, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/hasBooleanFlag\(flags, '(--[a-z-]+)'\)/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

describe('CLI parser — flags in front of the command', () => {
  it('a boolean flag does not eat the command', () => {
    const args = parseCommand(['node', 'cli', '--safe-mode', 'health', '--json']);

    expect(args.command).toBe('health');
    expect(args.safeMode).toBe(true);
    expect(args.json).toBe(true);
  });

  it('a boolean flag on its own still reads as boolean', () => {
    const args = parseCommand(['node', 'cli', 'health', '--json']);

    expect(args.command).toBe('health');
    expect(args.json).toBe(true);
  });

  it('every boolean flag leaves the command alone', () => {
    const offenders: string[] = [];
    for (const flag of BOOLEAN_FLAGS) {
      const args = parseCommand(['node', 'cli', flag, 'health']);
      if (args.command !== 'health') offenders.push(`${flag} -> ${String(args.command)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('a value flag still takes its value', () => {
    const args = parseCommand(['node', 'cli', 'chain', 'verify', '--chain', 'journal']);

    expect(args.command).toBe('chain');
    expect(args.subcommand).toBe('verify');
    expect(args.chain).toBe('journal');
  });

  it('a value flag takes its value even in front of the command', () => {
    const args = parseCommand(['node', 'cli', '--input', 'what is a chain', 'ask']);

    expect(args.command).toBe('ask');
    expect(args.input).toBe('what is a chain');
  });

  it('the --flag=value shape still works, for booleans and for values', () => {
    expect(parseCommand(['node', 'cli', 'health', '--json=true']).json).toBe(true);
    expect(parseCommand(['node', 'cli', 'health', '--json=false']).json).toBe(false);
    expect(parseCommand(['node', 'cli', 'ask', '--input=hello']).input).toBe('hello');
  });

  it('--cron keeps both shapes: boolean and value', () => {
    // `memphis health --cron` — boolean.
    const boolean = parseCommand(['node', 'cli', 'health', '--cron']);
    expect(boolean.cron).toBe(true);
    expect(boolean.command).toBe('health');

    // `memphis schedule ... --cron "0 3 * * *"` — a value.
    const withValue = parseCommand(['node', 'cli', 'schedule', 'set', '--cron', '0 3 * * *']);
    expect(withValue.cronPattern).toBe('0 3 * * *');
  });

  it('the exported list covers every flag the parser reads as boolean', () => {
    // `--cron` is the one documented exception: it is both.
    const missing = booleanFlagsReadByTheParser().filter(
      (flag) => flag !== '--cron' && !BOOLEAN_FLAGS.has(flag),
    );
    expect(missing).toEqual([]);
  });

  it('the exported list holds no flag the parser does not read as boolean', () => {
    const read = new Set(booleanFlagsReadByTheParser());
    const extra = [...BOOLEAN_FLAGS].filter((flag) => !read.has(flag)).sort();
    expect(extra).toEqual([]);
  });

  it('the case query flags reach the command that reads them', () => {
    // MEASURED 2026-11-24 on the operator's host:
    //
    // ```text
    // $ memphis explain --case-type genitive
    //   Chain: journal (20 recent blocks)      <- twenty JOURNAL blocks
    // ```
    //
    // The usage line PROMISED the flags —
    // `explain [--chain <name>] [--case-type <type>] [--entity <name>]` —
    // and the explain command READ them, and the parser had no slot for
    // either: `CliArgs` had no `caseType` and no `entity`, so the flags
    // were dropped on the floor and the command fell through to the
    // journal chain. The case path was unreachable, and the operator's
    // request was answered with a different question.
    const args = parseCommand(['node', 'cli', 'explain', '--case-type', 'genitive']);

    expect(args.command).toBe('explain');
    expect(args.caseType).toBe('genitive');

    const withEntity = parseCommand(['node', 'cli', 'explain', '--entity', 'soul']);
    expect(withEntity.entity).toBe('soul');

    // And the `--flag=value` shape, which the parser supports for every
    // other flag.
    const equals = parseCommand(['node', 'cli', 'explain', '--case-type=instrumental']);
    expect(equals.caseType).toBe('instrumental');
  });
});
