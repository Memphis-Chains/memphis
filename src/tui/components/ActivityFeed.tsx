import type { DashboardActivity } from '../dashboard-data.js';

export function renderActivityFeed(items: DashboardActivity[]): string[] {
  return ['📊 Live Activity', ...items.slice(0, 5).map((item) => `${item.time} ${item.message}`)];
}
