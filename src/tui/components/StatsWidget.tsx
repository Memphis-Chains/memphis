import type { DashboardStats } from '../dashboard-data.js';

function line(label: string, value: string): string {
  return `${label.padEnd(11, ' ')} ${value}`;
}

export function renderStatsWidget(stats: DashboardStats): string[] {
  return [
    '🧠 Memphis-v5 Dashboard',
    line('Chains:', `${stats.totalBlocks} blocks (↑ ${stats.todayBlocks} today)`),
    line('Cognitive:', stats.modelStatus),
    line('Memory:', `${stats.embeddingCount} embeddings`),
    line('Uptime:', stats.uptime),
  ];
}
