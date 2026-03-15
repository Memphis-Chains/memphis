import chalk from 'chalk';

import { initializeWorkspace, syncWorkspaceContext } from '../../../modules/workspace/context.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function printWorkspaceHelp(json: boolean): void {
  print(
    {
      usage:
        'memphis workspace init [path] [--force] [--json] | memphis context sync [path] [--force] [--json]',
      notes:
        'workspace init scaffolds .memphis/context.json plus AGENTS.md and CLAUDE.md; context sync refreshes the Memphis-managed blocks in those files.',
    },
    json,
  );
}

function printWorkspaceResultHuman(
  action: string,
  result: ReturnType<typeof initializeWorkspace>,
): void {
  console.log(chalk.cyan(`workspace ${action}`));
  console.log(`root: ${result.root}`);
  console.log(`context: ${result.contextPath}`);
  for (const status of result.statuses) {
    console.log(`${status.kind}:${status.status} ${status.path}`);
    console.log(`  ${status.detail}`);
  }
}

export async function handleWorkspaceCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, json, force, target } = context.args;
  if (command !== 'workspace' && command !== 'context') return false;

  if (
    !subcommand ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    (command === 'context' && subcommand !== 'sync')
  ) {
    printWorkspaceHelp(json);
    return true;
  }

  if (command === 'workspace' && subcommand === 'init') {
    const result = initializeWorkspace(target, { force });
    if (json) {
      print({ ok: true, action: 'workspace.init', ...result }, true);
    } else {
      printWorkspaceResultHuman('init', result);
    }
    return true;
  }

  if (
    (command === 'workspace' && subcommand === 'sync') ||
    (command === 'context' && subcommand === 'sync')
  ) {
    const result = syncWorkspaceContext(target, { force });
    if (json) {
      print({ ok: true, action: 'context.sync', ...result }, true);
    } else {
      printWorkspaceResultHuman('sync', result);
    }
    return true;
  }

  throw new Error(`Unknown ${command} subcommand: ${String(subcommand)}`);
}
