import { createCliContext } from './context.js';
import { dispatchCommand } from './handlers/command-handler.js';
import { CLI_COMPLETION_COMMANDS, getCliCommandRegistrations } from './registry.js';
import type { CliArgs } from './types.js';

/**
 * Operators sometimes type a verb where Memphis expects a noun:
 *   `memphis add provider minimax`  ← wrong
 *   `memphis provider add minimax`  ← right (noun first, verb is the subcommand)
 *
 * When `add`/`remove`/`list`/etc. lands as the top-level command, the
 * dispatcher fails with "Unknown command: add" — useless. This map names
 * the actual `<noun> <verb>` shapes so the error tells the operator where
 * the verb belongs.
 */
const VERB_FIRST_HINTS: Record<string, readonly string[]> = {
  add: ['memphis vault add', 'memphis provider add', 'memphis trust add', 'memphis schedule add'],
  remove: ['memphis vault remove', 'memphis trust remove', 'memphis schedule remove'],
  rotate: ['memphis vault master-key-rotate', 'memphis vault pepper-rotate'],
  recover: ['memphis vault recovery-unlock', 'memphis operator recover'],
  set: ['memphis config set'],
  get: ['memphis config get'],
  show: ['memphis config show'],
  status: ['memphis health', 'memphis tier status', 'memphis service status'],
};

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const curr: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return curr[n];
}

function suggestSimilarCommands(unknown: string): string[] {
  const lower = unknown.toLowerCase();
  const candidates: { name: string; distance: number }[] = [];
  for (const command of CLI_COMPLETION_COMMANDS) {
    const distance = levenshtein(lower, command.toLowerCase());
    if (distance <= 2) candidates.push({ name: command, distance });
  }
  return candidates
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3)
    .map((c) => c.name);
}

export function buildUnknownCommandMessage(unknown: string): string {
  const lines = [`Unknown command: ${unknown}`];
  const verbHint = VERB_FIRST_HINTS[unknown.toLowerCase()];
  if (verbHint && verbHint.length > 0) {
    lines.push('');
    lines.push('Did you mean (the verb goes after the noun):');
    for (const hint of verbHint) lines.push(`  ${hint}`);
  } else {
    const similar = suggestSimilarCommands(unknown);
    if (similar.length > 0) {
      lines.push('');
      lines.push(`Did you mean: ${similar.join(', ')}?`);
    }
  }
  lines.push('');
  lines.push('Run `memphis help` for the full command list.');
  return lines.join('\n');
}

/**
 * Optional dependency-injection seam for the registry resolver.
 *
 * Closure sprint Z.3.1 (2026-05-09): the macOS-only test failure
 * documented in #407 was a Vitest `vi.doMock` race against parallel
 * dynamic imports — on Linux the mock registration committed before
 * the dispatcher resolved its top-of-file `import` of
 * `getCliCommandRegistrations`; on macOS-latest the order intermittently
 * flipped, dispatcher pulled the REAL registry, and the mocked handler
 * was never called. The previous workaround (an extra
 * `await Promise.resolve()` microtask before `await import()`) didn't
 * fully extinguish it because the underlying module-cache invalidation
 * timing is platform-dependent.
 *
 * This signature change retires the race entirely: tests pass a registry
 * function directly, no module mocking required. Production callers
 * default to the real `getCliCommandRegistrations` so the public CLI
 * surface is unchanged.
 */
export async function executeCommand(
  argv: string[],
  args: CliArgs,
  registry: typeof getCliCommandRegistrations = getCliCommandRegistrations,
): Promise<void> {
  const hasHelpFlag = argv.includes('--help');
  const normalizedArgs =
    hasHelpFlag && args.command !== 'help' && args.command !== '--help'
      ? { ...args, command: 'help', subcommand: undefined, target: undefined }
      : args;

  const context = createCliContext(argv, normalizedArgs);
  const registrations = registry(normalizedArgs.command);
  const handlers = await Promise.all(
    registrations.map((registration) => registration.loadHandler()),
  );

  const handled = await dispatchCommand(context, handlers);

  if (!handled) {
    throw new Error(buildUnknownCommandMessage(normalizedArgs.command ?? ''));
  }
}
