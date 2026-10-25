import assert from 'node:assert/strict';
import { basename, isAbsolute, relative } from 'node:path';

assert.equal(process.env.NODE_ENV, 'test');
const root = process.env.MEMPHIS_RUNTIME_ROOT ?? '';
assert.ok(basename(root).startsWith('memphis-vitest-'), 'CLI fixture requires an isolated root');
for (const name of ['MEMPHIS_ENV_FILE', 'MEMPHIS_VAULT_STATE_PATH', 'MEMPHIS_VAULT_ENTRIES_PATH']) {
  const inside = relative(root, process.env[name] ?? '');
  assert.ok(
    inside && !inside.startsWith('..') && !isAbsolute(inside),
    'CLI fixture paths must stay inside its root',
  );
}
const operation = process.argv[2];
assert.ok(['add', 'get', 'list'].includes(operation));
const argv = ['node', 'memphis', 'secret', operation, '--key', 'first', '--json'];
if (operation === 'add') argv.push('--value', 'synthetic-private-provided-value');
process.argv = argv;
// Project imports happen only after the path guards. Establish a test session
// without changing any operator configuration or passphrase.
const { authorizeSession } = await import('../../src/infra/auth/operator-gate.js');
const { createCliContext } = await import('../../src/infra/cli/context.js');
const { parseCommand } = await import('../../src/infra/cli/parser.js');
const { secretCommandHandler } = await import('../../src/infra/cli/handlers/secret.handler.js');
authorizeSession();
await secretCommandHandler.handle(createCliContext(argv, parseCommand(argv)));
await Promise.all([
  new Promise<void>((done) => process.stdout.write('', () => done())),
  new Promise<void>((done) => process.stderr.write('', () => done())),
]);
// Exercise the chosen exit status; native finalizer stress is a separate suite.
process.exit(Number(process.exitCode ?? 0));
