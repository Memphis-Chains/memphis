import chalk from 'chalk';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function frame(progress: number): string {
  const width = 24;
  const filled = Math.round((Math.max(0, Math.min(100, progress)) / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${String(progress).padStart(3)}%`;
}

export async function celebrate(milestone: string): Promise<void> {
  process.stdout.write('\x1Bc');
  process.stdout.write(chalk.magenta.bold('△⬡◈ MEMPHIS MILESTONE CELEBRATION △⬡◈\n\n'));
  process.stdout.write(chalk.cyan(`Unlocked: ${milestone}\n\n`));

  for (let p = 0; p <= 100; p += 5) {
    process.stdout.write(`\r${chalk.yellow(frame(p))}`);
    await sleep(35);
  }

  process.stdout.write('\n\n');
  process.stdout.write(chalk.green.bold('CONGRATULATIONS, CREATOR.\n'));
  process.stdout.write(chalk.white('OpenClaw executes. Memphis remembers.\n'));
  process.stdout.write('🔔✨🚀\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const milestone = process.argv.slice(2).join(' ').trim() || 'V5 Milestone';
  celebrate(milestone).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
