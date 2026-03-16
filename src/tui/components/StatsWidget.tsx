import type { DashboardStats } from '../dashboard-data.js';
import {
  FG_CHAIN,
  FG_COPPER,
  FG_COPPER_BRIGHT,
  FG_STEEL,
  FG_TEAL,
  FG_WARM,
  FG_WHITE,
  RESET,
} from '../theme.js';

function stat(label: string, value: string, color = FG_COPPER): string {
  return `${FG_STEEL}${label.padEnd(11)}${RESET} ${color}${value}${RESET}`;
}

export function renderStatsWidget(stats: DashboardStats): string[] {
  return [
    stat(
      'Chains',
      `${FG_WHITE}${stats.totalBlocks}${RESET} ${FG_STEEL}blocks${RESET} ${FG_TEAL}\u2191 ${stats.todayBlocks}${RESET} ${FG_STEEL}today${RESET}`,
      '',
    ),
    stat('Cognitive', stats.modelStatus, FG_COPPER_BRIGHT),
    stat('Memory', `${stats.embeddingCount} embeddings`, FG_CHAIN),
    stat('Uptime', stats.uptime, FG_WARM),
  ];
}
