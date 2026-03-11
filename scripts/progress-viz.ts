import chalk from 'chalk';

export interface Milestone {
  name: string;
  progress: number; // 0-100
  status: 'complete' | 'in-progress' | 'pending';
}

function statusMeta(status: Milestone['status']): { emoji: string; color: (value: string) => string } {
  switch (status) {
    case 'complete':
      return { emoji: '✅', color: chalk.green };
    case 'in-progress':
      return { emoji: '🔄', color: chalk.yellow };
    case 'pending':
      return { emoji: '⏳', color: chalk.gray };
  }
}

function bar(progress: number, width = 12): string {
  const normalized = Math.max(0, Math.min(100, progress));
  const filled = Math.round((normalized / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

export function renderProgress(milestones: Milestone[]): string {
  const longestName = Math.max(...milestones.map((m) => m.name.length), 8);
  return milestones
    .map((m) => {
      const meta = statusMeta(m.status);
      const line = `${m.name.padEnd(longestName)}  ${bar(m.progress)} ${String(m.progress).padStart(3)}% ${meta.emoji}`;
      return meta.color(line);
    })
    .join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const roadmap: Milestone[] = [
    { name: 'V5.1 Integration', progress: 82, status: 'complete' },
    { name: 'V5.2 Cognitive', progress: 64, status: 'in-progress' },
    { name: 'V5.3 Reflection', progress: 45, status: 'in-progress' },
    { name: 'V5.4 Production', progress: 25, status: 'pending' },
  ];

  process.stdout.write(`${chalk.bold.cyan('△⬡◈ MEMPHIS V5 ROADMAP')}\n${renderProgress(roadmap)}\n`);
}
