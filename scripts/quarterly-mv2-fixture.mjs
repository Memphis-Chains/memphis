// Synthetic acceptance data only. All chain/vault writes use application APIs.
import { randomBytes } from 'node:crypto';

import { identityCommandHandler } from '../dist/infra/cli/handlers/identity.handler.js';
import { appendBlock } from '../dist/infra/storage/chain-adapter.js';
import { initializeVault } from '../dist/security/vault-boundary.js';

const passphrase = randomBytes(32).toString('hex');
initializeVault(
  {
    passphrase,
    recovery_question: 'Ephemeral Q2 fixture?',
    recovery_answer: randomBytes(32).toString('hex'),
  },
  { surface: 'cli', command: 'quarterly synthetic fixture' },
  process.env,
);
await identityCommandHandler.handle({
  args: { command: 'identity', subcommand: 'init', json: true },
});
if (process.exitCode) throw new Error('Synthetic identity initialization failed');
for (const chain of ['journal', 'decisions', 'reflections', 'cases', 'patterns', 'system'])
  await appendBlock(
    chain,
    {
      type: 'journal',
      content: `Synthetic Q2 ${chain} acceptance fixture`,
      tags: ['synthetic', 'quarterly'],
    },
    process.env,
  );
