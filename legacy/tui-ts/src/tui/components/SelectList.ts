/**
 * SelectList — Keyboard-navigable selection list.
 * Supports arrow keys, Enter to select, and provides visual feedback for selection.
 */

import type { Component, MemphisKey } from '../component.js';

export type SelectListItem = {
  id: string;
  label: string;
  detail?: string;
};

export type SelectListProps = {
  items: SelectListItem[];
  selectedIndex: number;
  onSelect?: (item: SelectListItem, index: number) => void;
  onMove?: (index: number) => void;
  /** Render each item as string[] — defaults to simple label render */
  renderItem?: (item: SelectListItem, selected: boolean) => string[];
};

export class SelectList implements Component {
  private _dirty = true;
  focused = false;

  constructor(private props: SelectListProps) {}

  render(width: number): string[] {
    const { items, selectedIndex, renderItem } = this.props;
    if (items.length === 0) return [];

    return items.map((item, i) => {
      const selected = i === selectedIndex;
      const prefix = selected ? (this.focused ? '>' : '*') : ' ';
      if (renderItem) {
        const lines = renderItem(item, selected);
        return lines.length > 0 ? `${prefix} ${lines[0]}` : '';
      }
      const label =
        item.label.length > width - 3 ? item.label.slice(0, width - 6) + '...' : item.label;
      return `${prefix} ${label}${item.detail ? `  ${item.detail}` : ''}`;
    });
  }

  handleInput(key: MemphisKey): void {
    const { items, selectedIndex, onSelect, onMove } = this.props;

    if (items.length === 0) return;

    if (key.name === 'down' || (key.name === 'tab' && !key.ctrl)) {
      const next = (selectedIndex + 1) % items.length;
      onMove?.(next);
      this._dirty = true;
    } else if (key.name === 'up') {
      const prev = selectedIndex === 0 ? items.length - 1 : selectedIndex - 1;
      onMove?.(prev);
      this._dirty = true;
    } else if (key.name === 'return' || key.name === 'enter') {
      onSelect?.(items[selectedIndex], selectedIndex);
    }
  }

  invalidate(): void {
    this._dirty = true;
  }

  focus(): void {
    this.focused = true;
    this._dirty = true;
  }

  blur(): void {
    this.focused = false;
    this._dirty = true;
  }

  isDirty(): boolean {
    return this._dirty;
  }

  markClean(): void {
    this._dirty = false;
  }
}
