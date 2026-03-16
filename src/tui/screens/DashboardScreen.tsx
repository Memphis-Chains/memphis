import type { DashboardData } from '../dashboard-data.js';
import { renderStatsWidget } from '../components/StatsWidget.js';
import { renderActivityFeed } from '../components/ActivityFeed.js';
import { renderInsightsWidget } from '../components/InsightsWidget.js';
import { renderQuickActions } from '../components/QuickActions.js';
import { FG_CHAIN, FG_COPPER, FG_EMBED, FG_TEAL, MEMPHIS_LOGO, themedBox } from '../theme.js';

export function renderDashboardScreen(data: DashboardData, width: number): string[] {
  const widgetWidth = Math.max(40, Math.min(66, width - 4));

  const logo = width >= 56 ? [...MEMPHIS_LOGO, ''] : [];
  const stats = themedBox('System', renderStatsWidget(data.stats), widgetWidth, FG_COPPER, 5);
  const activity = themedBox(
    'Activity',
    renderActivityFeed(data.activities),
    widgetWidth,
    FG_CHAIN,
    6,
  );
  const insights = themedBox(
    'Cognitive',
    renderInsightsWidget(data.insights),
    widgetWidth,
    FG_EMBED,
    5,
  );
  const actions = themedBox('Actions', renderQuickActions(), widgetWidth, FG_TEAL, 2);

  return [...logo, ...stats, '', ...activity, '', ...insights, '', ...actions];
}
