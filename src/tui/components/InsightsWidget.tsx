import type { DashboardInsights } from '../dashboard-data.js';

export function renderInsightsWidget(insights: DashboardInsights): string[] {
  return [
    '💡 Cognitive Insights',
    `Top topics: ${insights.topTopics.join(', ')}`,
    `Patterns: ${insights.patternsLoaded} loaded`,
    `Learning: ${(insights.learningAccuracy * 100).toFixed(1)}% accuracy`,
    `Suggestions: ${insights.suggestionsPending} pending`,
  ];
}
