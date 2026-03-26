/**
 * Box — Themed bordered container component.
 * Wraps content in a box with a title and configurable colors.
 */

import type { Component } from '../component.js';
import { themedBox } from '../theme.js';

export type BoxProps = {
  title: string;
  /** Content lines to render inside the box */
  content: string[];
  width: number;
  /** Border color escape sequence (e.g., FG_COPPER) */
  color: string;
  /** Maximum content lines (box clamps to this) */
  maxLines?: number;
};

export class Box implements Component {
  private _dirty = true;

  constructor(private props: BoxProps) {}

  render(width: number): string[] {
    const { title, content, color, maxLines = 6 } = this.props;
    const boxWidth = Math.max(20, Math.min(width, 80));
    return themedBox(title, content, boxWidth, color, maxLines);
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

  /** Update props and mark dirty */
  update(props: Partial<BoxProps>): void {
    this.props = { ...this.props, ...props };
    this._dirty = true;
  }
}
