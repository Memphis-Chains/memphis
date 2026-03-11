import type { DashboardData } from '../dashboard-data.js';
import { renderStatsWidget } from '../components/StatsWidget.js';
import { renderActivityFeed } from '../components/ActivityFeed.js';
import { renderInsightsWidget } from '../components/InsightsWidget.js';
import { renderQuickActions } from '../components/QuickActions.js';

function clip(value: string, width: number): string {
  if (width <= 1) return '…';
  return value.length > width ? `${value.slice(0, Math.max(1, width - 1))}…` : value;
}

function box(lines: string[], width: number, color = '\x1b[36m'): string[] {
  const inner = Math.max(8, width - 2);
  const top = `${color}┌${'─'.repeat(inner)}┐\x1b[0m`;
  const mid = `${color}├${'─'.repeat(inner)}┤\x1b[0m`;
  const body = lines.map((line, idx) => {
    const clean = clip(line, inner - 2).padEnd(inner - 2, ' ');
    if (idx === 0) return `${color}│\x1b[0m ${clean} ${color}│\x1b[0m`;
    return `${color}│\x1b[0m ${clean} ${color}│\x1b[0m`;
  });
  const bottom = `${color}└${'─'.repeat(inner)}┘\x1b[0m`;
  return [top, mid, ...body.slice(0, 5), bottom];
}

export function renderDashboardScreen(data: DashboardData, width: number): string[] {
  const widgetWidth = Math.max(40, Math.min(66, width - 6));

  const stats = box(renderStatsWidget(data.stats), widgetWidth, '\x1b[35m');
  const activity = box(renderActivityFeed(data.activities), widgetWidth, '\x1b[34m');
  const insights = box(renderInsightsWidget(data.insights), widgetWidth, '\x1b[33m');
  const actions = box(renderQuickActions(), widgetWidth, '\x1b[32m');

  return [...stats, '', ...activity, '', ...insights, '', ...actions];
}
