/**
 * Spinner — ASCII loading animation.
 * Renders a rotating spinner frame based on elapsed time.
 */

import type { Component } from '../component.js';

const SPINNER_FRAMES = [
  '\u2847', // ◧
  '\u2857', // ◧ bright
  '\u2867', // ◧
  '\u28b7', // ◧ bright
  '\u28f7', // ◧
  '\u28ef', // ◧ bright
  '\u28df', // ◧
  '\u28bf', // ◧ bright
] as const;

export type SpinnerProps = {
  label?: string;
  /** Custom frames array, defaults to SPINNER_FRAMES */
  frames?: readonly string[];
  /** Color escape sequence (e.g., FG_COPPER) */
  color?: string;
  /** Reset escape sequence */
  reset?: string;
};

export class Spinner implements Component {
  private _dirty = true;
  private startTime = Date.now();

  constructor(private props: SpinnerProps = {}) {}

  render(width: number): string[] {
    const { label = '', frames = SPINNER_FRAMES, color = '', reset = '\x1b[0m' } = this.props;
    const elapsed = Math.floor((Date.now() - this.startTime) / 100) % frames.length;
    const frame = frames[elapsed] ?? frames[0];
    const content = `${color}${frame}${reset} ${label}`;
    return content.length > width ? [content.slice(0, width - 1)] : [content];
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

  /** Reset the animation start time */
  reset(): void {
    this.startTime = Date.now();
  }
}
