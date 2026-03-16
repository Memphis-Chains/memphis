import type { DashboardInsights } from '../dashboard-data.js';
import {
  FG_COPPER,
  FG_COPPER_BRIGHT,
  FG_EMBED,
  FG_STEEL,
  FG_TEAL,
  FG_WARM,
  FG_WHITE,
  RESET,
  progressBar,
} from '../theme.js';

export function renderInsightsWidget(insights: DashboardInsights): string[] {
  const topics = insights.topTopics
    .map((t) => `${FG_COPPER_BRIGHT}${t}${RESET}`)
    .join(`${FG_STEEL}, ${RESET}`);
  const acc = insights.learningAccuracy;
  const accColor = acc >= 0.9 ? FG_TEAL : acc >= 0.7 ? FG_COPPER : FG_EMBED;
  return [
    `${FG_STEEL}topics${RESET}      ${topics}`,
    `${FG_STEEL}patterns${RESET}    ${FG_WHITE}${insights.patternsLoaded}${RESET} ${FG_STEEL}loaded${RESET}`,
    `${FG_STEEL}accuracy${RESET}    ${progressBar(acc, 8)} ${accColor}${(acc * 100).toFixed(1)}%${RESET}`,
    `${FG_STEEL}pending${RESET}     ${FG_WARM}${insights.suggestionsPending}${RESET} ${FG_STEEL}suggestions${RESET}`,
  ];
}
