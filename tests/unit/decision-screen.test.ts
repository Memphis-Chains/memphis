import { describe, expect, test } from 'vitest';
import { loadDecisionScreen, renderDecisionScreen } from '../../src/tui/screens/decision-screen.js';

describe('DecisionScreen', () => {
  test('shows loading and empty states', () => {
    expect(renderDecisionScreen({ loading: true, error: null, decisions: [] })).toContain('Loading decisions');
    expect(renderDecisionScreen({ loading: false, error: null, decisions: [] })).toContain('No decisions recorded yet');
  });

  test('handles load errors with guidance', async () => {
    const state = await loadDecisionScreen(async () => {
      throw new Error('db unavailable');
    });

    const view = renderDecisionScreen(state);
    expect(view).toContain('Failed to load decisions: db unavailable');
    expect(view).toContain('memphis verify');
  });
});
