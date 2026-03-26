import { describe, expect, it } from 'vitest';

import { RootLayout } from '../src/tui/RootLayout.js';

describe('RootLayout scrolling', () => {
  it('scrolls toward older content with bounds', () => {
    const layout = new RootLayout('chat');

    layout.scrollOlder(50, 10, 10);
    expect(layout.scrollOffset).toBe(10);

    layout.scrollOlder(50, 10, 100);
    expect(layout.scrollOffset).toBe(40);
  });

  it('scrolls back toward the latest content', () => {
    const layout = new RootLayout('chat');

    layout.scrollOlder(50, 10, 20);
    layout.scrollNewer(5);
    expect(layout.scrollOffset).toBe(15);

    layout.scrollToLatest();
    expect(layout.scrollOffset).toBe(0);
  });

  it('jumps to the oldest visible page and reclamps after content shrink', () => {
    const layout = new RootLayout('chat');

    layout.scrollToOldest(50, 10);
    expect(layout.scrollOffset).toBe(40);

    layout.clampScroll(5, 10);
    expect(layout.scrollOffset).toBe(0);
  });
});
