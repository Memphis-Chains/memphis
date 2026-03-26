/**
 * DecisionScreen — TUI component for decision history.
 * Wraps renderDecisionScreen with async data loading.
 */

import type { Decision, DecisionScreenState } from './decision-screen.js';
import { loadDecisionScreen, renderDecisionScreen, loadDecisionsFromChain } from './decision-screen.js';
import type { Component } from '../component.js';

export class DecisionScreenComponent implements Component {
  private _dirty = true;
  private screenState: DecisionScreenState = {
    loading: true,
    error: null,
    decisions: [],
  };

  async refresh(loadDecisions: () => Promise<Decision[]> = loadDecisionsFromChain): Promise<void> {
    this.screenState = await loadDecisionScreen(loadDecisions);
    this._dirty = true;
  }

  render(width: number): string[] {
    const output = renderDecisionScreen(this.screenState);
    return output.split('\n').map((l) => (l.length > width ? l.slice(0, width - 1) : l));
  }

  invalidate(): void {
    this._dirty = true;
  }

  isDirty(): boolean {
    return this._dirty;
  }

  markClean(): void {
    this._dirty = false;
  }
}
