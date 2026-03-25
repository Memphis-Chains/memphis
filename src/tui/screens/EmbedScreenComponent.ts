/**
 * EmbedScreen — TUI component for embedding search/store.
 * Wraps embedSearchScreen and embedStoreScreen.
 */

import { embedSearchScreen } from './embed-screen.js';
import type { Component } from '../component.js';

export type EmbedScreenState = {
  query: string;
  topK: number;
  tuned: boolean;
  lastResult: string | null;
};

export class EmbedScreenComponent implements Component {
  private _dirty = true;
  private state: EmbedScreenState = {
    query: '',
    topK: 5,
    tuned: false,
    lastResult: null,
  };

  render(width: number): string[] {
    if (!this.state.query) {
      return ['embed search ready', 'Usage: /embed search <query>'];
    }
    const result = embedSearchScreen(this.state.query, this.state.topK, this.state.tuned);
    const lines = result.split('\n');
    // Clip each line to width
    return lines.map((l) => (l.length > width ? l.slice(0, width - 1) : l));
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

  /** Perform a search and cache result */
  search(query: string, topK = 5, tuned = false): void {
    this.state = { query, topK, tuned, lastResult: null };
    this._dirty = true;
  }

  /** Clear the current query and results */
  clear(): void {
    this.state = { query: '', topK: 5, tuned: false, lastResult: null };
    this._dirty = true;
  }
}
