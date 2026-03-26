import type { DashboardActivity } from '../dashboard-data.js';
import { FG_STEEL, FG_TEAL, FG_WARM, RESET } from '../theme.js';

export function renderActivityFeed(items: DashboardActivity[]): string[] {
  return items.slice(0, 5).map((item) => {
    const icon = item.message.startsWith('\u2713')
      ? `${FG_TEAL}\u2713${RESET}`
      : `${FG_STEEL}\u2022${RESET}`;
    const text = item.message.replace(/^[\u2713\u2022]\s*/, '');
    return `${FG_STEEL}${item.time}${RESET} ${icon} ${FG_WARM}${text}${RESET}`;
  });
}
