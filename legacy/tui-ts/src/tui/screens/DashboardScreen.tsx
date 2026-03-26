import type { DashboardData } from '../dashboard-data.js';
import { renderStatsWidget } from '../components/StatsWidget.js';
import { renderActivityFeed } from '../components/ActivityFeed.js';
import { renderInsightsWidget } from '../components/InsightsWidget.js';
import { renderQuickActions } from '../components/QuickActions.js';
import { FG_CHAIN, FG_COPPER, FG_EMBED, FG_TEAL, MEMPHIS_LOGO, themedBox } from '../theme.js';

export type DashboardScreenOptions = {
  /** Widget name to expand (null = all collapsed) */
  expandedWidget?: string | null;
  /** Available rows for expanded widget height */
  availableBodyRows?: number;
};

export function renderDashboardScreen(
  data: DashboardData,
  width: number,
  options: DashboardScreenOptions = {},
): string[] {
  const { expandedWidget = null, availableBodyRows = 24 } = options;
  const widgetWidth = Math.max(40, Math.min(66, width - 4));

  const logo = width >= 56 ? [...MEMPHIS_LOGO, ''] : [];

  const maxLinesCollapsed = 6;
  const maxLinesExpanded = availableBodyRows - 4;

  const isExpanded = (name: string) => expandedWidget === name;
  const getMaxLines = (name: string) => (isExpanded(name) ? maxLinesExpanded : maxLinesCollapsed);

  const stats = themedBox(
    'System',
    renderStatsWidget(data.stats),
    widgetWidth,
    FG_COPPER,
    getMaxLines('System'),
  );
  const activity = themedBox(
    'Activity',
    renderActivityFeed(data.activities),
    widgetWidth,
    FG_CHAIN,
    getMaxLines('Activity'),
  );
  const insights = themedBox(
    'Cognitive',
    renderInsightsWidget(data.insights),
    widgetWidth,
    FG_EMBED,
    getMaxLines('Cognitive'),
  );
  const actions = themedBox('Actions', renderQuickActions(), widgetWidth, FG_TEAL, 2);

  return [...logo, ...stats, '', ...activity, '', ...insights, '', ...actions];
}

export function toggleExpandedWidget(
  current: string | null,
  widgetName: string,
): string | null {
  return current === widgetName ? null : widgetName;
}
