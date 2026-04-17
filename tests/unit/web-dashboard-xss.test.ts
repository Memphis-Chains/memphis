import { describe, expect, it } from 'vitest';

import { WebDashboard, type DashboardData } from '../../src/dashboard/web-dashboard.ts';

/**
 * Regression net for #138. Dashboard HTML used to interpolate
 * AI-generated predictions, insights, actions, quick-wins, and tag names
 * directly into template literals with no escaping — a stored XSS vector
 * for any input that reaches the dashboard (via federation sync, via
 * prompt injection into the insight pipeline, etc.). Fix: esc() wraps
 * every dynamic field.
 */

function buildHostileData(): DashboardData {
  const payload = '<img src=x onerror="alert(1)">';
  return {
    stats: {
      totalBlocks: 1,
      totalChains: 1,
      oldestBlock: '2026-01-01',
      newestBlock: '2026-04-16',
      topTags: [{ tag: payload, count: 1 }],
      blocksPerChain: [{ chain: 'main', count: 1 }],
    },
    insights: [
      { type: 'pattern', title: payload, description: payload, confidence: 0.8 },
    ],
    predictions: [{ title: payload, confidence: 0.9, reasoning: payload }],
    mood: 'productive',
    quickWins: [payload],
    nextActions: [payload],
  };
}

describe('web-dashboard HTML escaping (#138)', () => {
  const dashboard = new WebDashboard(
    { port: 0, host: '127.0.0.1', refreshIntervalMs: 30_000 },
    async () => buildHostileData(),
  );

  it('escapes hostile payload in predictions', () => {
    const html = dashboard.renderDashboard(buildHostileData());
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  it('escapes in insights, actions, wins, tags', () => {
    const html = dashboard.renderDashboard(buildHostileData());
    // At least 5 occurrences (predictions.title, predictions.reasoning,
    // insights.title, insights.description, nextActions, quickWins, tag) —
    // assert ≥ 5 to be resilient to template reordering.
    const matches = html.match(/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(5);
  });

  it('preserves safe content unchanged', () => {
    const data = buildHostileData();
    data.predictions[0].title = 'Normal prediction title';
    data.predictions[0].reasoning = 'Because reasons';
    const html = dashboard.renderDashboard(data);
    expect(html).toContain('Normal prediction title');
    expect(html).toContain('Because reasons');
  });
});
