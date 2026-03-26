/**
 * Memphis TUI Component Model
 *
 * Screens return string[] (synchronous) or string (synchronous, joined later).
 * Async screens (health, chat, embed store) manage their own async state
 * internally and call invalidate() when content changes.
 *
 * Memphis key format: parsed key objects from emitKeypressEvents.
 * NOT raw terminal strings like pi-tui.
 */

/** Memphis key representation — matches key in index.ts onKeypress */
export interface MemphisKey {
  ctrl?: boolean;
  name?: string;
  str?: string;
}

/** Base TUI component interface */
export interface Component {
  /**
   * Render the component to an array of lines.
   * Each string in the array is one visual row.
   * Lines MUST NOT exceed `width` (use clip/wrap to enforce).
   */
  render(width: number): string[];

  /**
   * Handle a navigation keypress.
   * Only called for keys that aren't consumed by readline (arrows, Ctrl+, etc.)
   * Text input (letters, numbers) goes through readline.question().
   */
  handleInput?(key: MemphisKey): void;

  /** Mark component as dirty — next render will produce new output */
  invalidate(): void;

  /** Called when component gains keyboard focus */
  focus?(): void;

  /** Called when component loses keyboard focus */
  blur?(): void;

  /** Check if component needs re-render */
  isDirty?(): boolean;

  /** Mark component as clean after render */
  markClean?(): void;
}

/**
 * Focusable components can receive keyboard input.
 * Components that manage their own key handling implement this.
 */
export interface FocusableComponent extends Component {
  focused: boolean;
}

/**
 * TuiLayout — composes child components into a vertical layout.
 * Used as the root of the component tree.
 */
export class TuiLayout implements Component {
  children: Component[] = [];
  private _dirty = true;

  addChild(child: Component): void {
    this.children.push(child);
  }

  removeChild(child: Component): void {
    const idx = this.children.indexOf(child);
    if (idx !== -1) this.children.splice(idx, 1);
  }

  render(width: number): string[] {
    const out: string[] = [];
    for (const child of this.children) {
      out.push(...child.render(width));
    }
    return out;
  }

  handleInput(key: MemphisKey): void {
    for (const child of this.children) {
      if (child.handleInput) {
        child.handleInput(key);
      }
    }
  }

  invalidate(): void {
    this._dirty = true;
    for (const child of this.children) {
      child.invalidate?.();
    }
  }

  isDirty(): boolean {
    return this._dirty;
  }

  markClean(): void {
    this._dirty = false;
  }
}

/** Check if a component is focusable */
export function isFocusable(component: Component): component is FocusableComponent {
  return 'focused' in component && typeof (component as FocusableComponent).focused === 'boolean';
}

/** Re-export RootLayout for convenience */
export { RootLayout } from './RootLayout.js';
