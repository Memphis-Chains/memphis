/**
 * CommandPalette — Command palette overlay.
 * Shows filtered commands and allows fuzzy selection with Enter to execute.
 */

import type { Component, MemphisKey } from '../component.js';
import { BOLD, BOX_BOLD, FG_COPPER, FG_STEEL, FG_WARM, RESET } from '../theme.js';

export type PaletteCommand = {
  id: string;
  label: string;
  detail?: string;
};

export type CommandPaletteOptions = {
  commands: PaletteCommand[];
  filter: string;
  onSelect: (command: PaletteCommand) => void;
  onClose: () => void;
  width?: number;
};

export class CommandPalette implements Component {
  private _dirty = true;
  private _selectedIndex = 0;

  constructor(private options: CommandPaletteOptions) {}

  get selectedIndex(): number {
    return this._selectedIndex;
  }

  get filteredCommands(): PaletteCommand[] {
    const { commands, filter } = this.options;
    if (!filter) return commands;
    const lower = filter.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(lower) || (c.detail?.toLowerCase().includes(lower) ?? false),
    );
  }

  render(width: number): string[] {
    const w = Math.min(this.options.width ?? 60, width - 4);
    const lines: string[] = [];
    const push = (s: string) => lines.push(s);

    const filtered = this.filteredCommands;
    const innerWidth = w - 2;
    const filterDisplay = `> ${this.options.filter}`;
    const headerLen = innerWidth;
    const filterLen = filterDisplay.length;

    // Top border
    push(`${FG_COPPER}${BOX_BOLD.tl}${BOX_BOLD.h.repeat(headerLen)}${BOX_BOLD.tr}${RESET}`);
    // Filter row
    const filterPadded = filterDisplay + ' '.repeat(Math.max(0, headerLen - filterLen));
    push(
      `${FG_COPPER}${BOX_BOLD.v}${RESET}${FG_COPPER}${BOLD}${filterPadded}${RESET}${FG_COPPER}${BOX_BOLD.v}${RESET}`,
    );
    // Separator
    push(
      `${FG_COPPER}${BOX_BOLD.tee_up}${BOX_BOLD.h.repeat(innerWidth)}${BOX_BOLD.tee_up}${RESET}`,
    );

    // Command rows (up to 10)
    const maxRows = Math.min(filtered.length, 10);
    for (let i = 0; i < maxRows; i++) {
      const cmd = filtered[i];
      const selected = i === this._selectedIndex;
      const prefix = selected ? `${FG_WARM}>${RESET}` : ' ';
      const label =
        cmd.label.length > innerWidth - 4 ? cmd.label.slice(0, innerWidth - 7) + '...' : cmd.label;
      const detail = cmd.detail ? `  ${FG_STEEL}${cmd.detail}${RESET}` : '';
      const rowContent = `${prefix} ${label}${detail}`;
      const padded = rowContent.padEnd(innerWidth);
      const border = selected ? FG_COPPER : FG_STEEL;
      push(
        `${border}${BOX_BOLD.v}${RESET}${selected ? BOLD : ''}${padded}${RESET}${border}${BOX_BOLD.v}${RESET}`,
      );
    }

    // Empty rows if fewer commands
    for (let i = filtered.length; i < maxRows; i++) {
      push(
        `${FG_STEEL}${BOX_BOLD.v}${RESET}${' '.repeat(innerWidth)}${FG_STEEL}${BOX_BOLD.v}${RESET}`,
      );
    }

    // Bottom border
    push(`${FG_COPPER}${BOX_BOLD.bl}${BOX_BOLD.h.repeat(innerWidth)}${BOX_BOLD.br}${RESET}`);

    return lines;
  }

  handleInput(key: MemphisKey): void {
    const filtered = this.filteredCommands;
    if (filtered.length === 0) return;

    if (key.name === 'down') {
      this._selectedIndex = Math.min(this._selectedIndex + 1, filtered.length - 1);
      this._dirty = true;
    } else if (key.name === 'up') {
      this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
      this._dirty = true;
    } else if (key.name === 'return' || key.name === 'enter') {
      const cmd = filtered[this._selectedIndex];
      if (cmd) this.options.onSelect(cmd);
    } else if (key.name === 'escape') {
      this.options.onClose();
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
