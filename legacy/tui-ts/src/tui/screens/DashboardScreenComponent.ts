/**
 * DashboardScreen — TUI component for the main dashboard.
 * Wraps renderDashboardScreen with Component interface.
 */

import type { DashboardData } from '../dashboard-data.js';
import { renderDashboardScreen, toggleExpandedWidget } from './DashboardScreen.js';
import type { Component } from '../component.js';

export type DashboardScreenOptions = {
  /** Widget name to expand (null = all collapsed) */
  expandedWidget?: string | null;
  /** Available rows for expanded widget height */
  availableBodyRows?: number;
};

export class DashboardScreenComponent implements Component {
  private _dirty = true;

  constructor(
    private data: DashboardData,
    private options: DashboardScreenOptions = {},
  ) {}

  render(width: number): string[] {
    return renderDashboardScreen(this.data, width, this.options);
  }

  handleInput(key: { name?: string }): void {
    if (key.name === 'enter' && this.options.expandedWidget) {
      // Enter on expanded widget cycles it closed
      this.options.expandedWidget = null;
      this._dirty = true;
    }
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

  /** Toggle a widget's expanded state */
  toggleWidget(widgetName: string): void {
    this.options.expandedWidget = toggleExpandedWidget(
      this.options.expandedWidget ?? null,
      widgetName,
    );
    this._dirty = true;
  }

  /** Update the dashboard data */
  updateData(data: DashboardData): void {
    this.data = data;
    this._dirty = true;
  }
}
