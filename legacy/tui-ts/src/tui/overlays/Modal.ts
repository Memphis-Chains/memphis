/**
 * Modal — Base overlay component.
 * Overlays render on top of the base TUI render and intercept keypresses.
 */

import type { Component, MemphisKey } from '../component.js';
import { BOLD, BOX_BOLD, FG_COPPER, FG_STEEL, FG_WARM, RESET } from '../theme.js';

export type ModalButton = {
  label: string;
  /** Called when button is selected (Enter or clicked) */
  action: () => void;
  /** Destructive actions are rendered in warning color */
  destructive?: boolean;
};

export type ModalOptions = {
  /** Overlay title (shown in top border) */
  title: string;
  /** Body content lines */
  lines: string[];
  /** Buttons shown at bottom */
  buttons: ModalButton[];
  /** Width of the modal (auto-centered) */
  width?: number;
  /** Color for the modal border */
  color?: string;
};

export class Modal implements Component {
  private _dirty = true;
  private _selectedIndex = 0;

  constructor(private options: ModalOptions) {}

  render(width: number): string[] {
    const w = Math.min(this.options.width ?? 50, width - 4);
    const lines: string[] = [];
    const push = (s: string) => lines.push(s);

    const { title, lines: bodyLines, buttons, color = FG_COPPER } = this.options;
    const innerWidth = w - 2;
    const buttonRow = buttons
      .map((b, i) => {
        const sel = i === this._selectedIndex;
        const prefix = sel ? `[${b.label}]` : ` ${b.label} `;
        const btnColor = b.destructive ? FG_WARM : sel ? FG_COPPER : FG_STEEL;
        return `${btnColor}${BOLD}${prefix}${RESET}`;
      })
      .join(' ');

    // Top border with title
    const titleStr = ` ${title} `;
    const remainH = Math.max(0, innerWidth - titleStr.length);
    push(
      `${color}${BOX_BOLD.tl}${BOX_BOLD.h.repeat(titleStr.length)}${BOX_BOLD.h.repeat(remainH)}${BOX_BOLD.tr}${RESET}`,
    );
    // Title row
    const titleLine = `${color}${BOX_BOLD.v}${RESET}${FG_COPPER}${BOLD}${titleStr}${RESET}${color}${BOX_BOLD.v}${FG_WARM}${' '.repeat(remainH)}${BOX_BOLD.v}${RESET}`;
    push(titleLine);
    // Separator
    push(`${color}${BOX_BOLD.tee_up}${BOX_BOLD.h.repeat(innerWidth)}${BOX_BOLD.tee_up}${RESET}`);

    // Body lines
    for (const line of bodyLines) {
      const clipped = line.length > innerWidth - 2 ? line.slice(0, innerWidth - 3) + '…' : line;
      push(
        `${color}${BOX_BOLD.v}${RESET}${FG_STEEL}${clipped.padEnd(innerWidth)}${color}${BOX_BOLD.v}${RESET}`,
      );
    }

    // Empty line
    push(`${color}${BOX_BOLD.v}${RESET}${' '.repeat(innerWidth)}${color}${BOX_BOLD.v}${RESET}`);

    // Button row
    push(
      `${color}${BOX_BOLD.v}${RESET}${buttonRow.padEnd(innerWidth)}${color}${BOX_BOLD.v}${RESET}`,
    );

    // Bottom border
    push(`${color}${BOX_BOLD.bl}${BOX_BOLD.h.repeat(innerWidth)}${BOX_BOLD.br}${RESET}`);

    return lines;
  }

  handleInput(key: MemphisKey): void {
    const { buttons } = this.options;
    if (buttons.length === 0) return;

    if (key.name === 'left' || key.name === 'up') {
      this._selectedIndex = (this._selectedIndex - 1 + buttons.length) % buttons.length;
      this._dirty = true;
    } else if (key.name === 'right' || key.name === 'down') {
      this._selectedIndex = (this._selectedIndex + 1) % buttons.length;
      this._dirty = true;
    } else if (key.name === 'return' || key.name === 'enter') {
      buttons[this._selectedIndex].action();
    }
  }

  focus(): void {
    this._selectedIndex = 0;
    this._dirty = true;
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

/** ConfirmDialog — Simple confirmation overlay with Cancel/Confirm buttons */
export function confirmDialog(
  title: string,
  message: string,
  onConfirm: () => void,
  onCancel: () => void,
): Modal {
  return new Modal({
    title,
    lines: [message],
    buttons: [
      { label: 'Cancel', action: onCancel },
      { label: 'Confirm', action: onConfirm, destructive: true },
    ],
    width: Math.max(message.length + 6, 40),
  });
}
