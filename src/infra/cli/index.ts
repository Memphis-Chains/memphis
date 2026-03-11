import { executeCommand } from './dispatcher.js';
import { parseCommand } from './parser.js';

export async function runCli(argv: string[] = process.argv): Promise<void> {
  const args = parseCommand(argv);

  if (args.verbose) {
    process.env.LOG_LEVEL = 'debug';
  }

  await executeCommand(argv, args);
}

runCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(4);
});
