import * as readline from 'node:readline/promises';

import type { CommandHandler } from './command-handler.js';
import {
  changeOperatorPassphrase,
  enrollOperatorPassphrase,
  isOperatorConfigured,
  loadOperatorConfig,
  recoverOperatorPassphrase,
} from '../../auth/operator-gate.js';
import type { CliContext } from '../context.js';

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
}

async function handleOperatorStatus(context: CliContext): Promise<boolean> {
  const config = loadOperatorConfig(process.env);
  const configured = config !== null;

  if (context.args.json) {
    console.log(
      JSON.stringify(
        {
          configured,
          createdAt: config?.createdAt ?? null,
          updatedAt: config?.updatedAt ?? null,
          hasRecovery: !!config?.recoveryHash,
        },
        null,
        2,
      ),
    );
  } else {
    if (configured) {
      console.log('Operator passphrase: configured');
      console.log(`  Created:  ${config!.createdAt}`);
      console.log(`  Updated:  ${config!.updatedAt}`);
      console.log(`  Recovery: ${config!.recoveryHash ? 'yes' : 'no'}`);
    } else {
      console.log('Operator passphrase: not configured');
      console.log('Run "memphis init" or "memphis operator set-passphrase" to set one.');
    }
  }
  return true;
}

async function handleOperatorSetPassphrase(_context: CliContext): Promise<boolean> {
  const rl = createRl();
  try {
    const configured = isOperatorConfigured();
    const result = configured
      ? await changeOperatorPassphrase(rl)
      : await enrollOperatorPassphrase(rl);

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
    } else if (configured) {
      console.log('Operator passphrase updated.');
    }
  } finally {
    rl.close();
  }
  return true;
}

async function handleOperatorRecover(_context: CliContext): Promise<boolean> {
  const rl = createRl();
  try {
    const result = await recoverOperatorPassphrase(rl);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
    }
  } finally {
    rl.close();
  }
  return true;
}

async function handleOperatorCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;

  if (sub === 'status' || !sub) {
    return handleOperatorStatus(context);
  }
  if (sub === 'set-passphrase') {
    return handleOperatorSetPassphrase(context);
  }
  if (sub === 'recover') {
    return handleOperatorRecover(context);
  }

  console.error(`Unknown operator subcommand: ${sub}`);
  console.error('Usage: memphis operator <status|set-passphrase|recover>');
  return true;
}

export const operatorCommandHandler: CommandHandler = {
  name: 'operator',
  commands: ['operator'],
  canHandle: (context: CliContext) => context.args.command === 'operator',
  handle: handleOperatorCommand,
};
