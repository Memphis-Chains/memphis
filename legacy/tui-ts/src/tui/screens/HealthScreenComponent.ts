/**
 * HealthScreen — TUI component for provider health display.
 * Handles async rendering of health status.
 */

import { renderHealthScreen } from './health-screen.js';
import type { OrchestrationService } from '../../modules/orchestration/service.js';
import type { Component } from '../component.js';

export class HealthScreenComponent implements Component {
  private _dirty = true;
  private cachedLines: string[] = [];
  private loading = true;
  private error: string | null = null;

  constructor(private orchestration: OrchestrationService) {}

  async refresh(): Promise<void> {
    this.loading = true;
    this._dirty = true;

    try {
      const output = await renderHealthScreen(this.orchestration);
      this.cachedLines = output.split('\n');
      this.error = null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.cachedLines = [`error: ${this.error}`];
    } finally {
      this.loading = false;
      this._dirty = true;
    }
  }

  render(_width: number): string[] {
    if (this.loading) {
      return ['loading...'];
    }
    return this.cachedLines;
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
