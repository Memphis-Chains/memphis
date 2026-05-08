import { describe, expect, it } from 'vitest';

import { escapeMarkdownV2 } from '../../src/gateway/channels/telegram-escape.js';

describe('escapeMarkdownV2', () => {
  it('escapes every reserved MarkdownV2 character', () => {
    const reserved = '_*[]()~`>#+-=|{}.!\\';
    const escaped = escapeMarkdownV2(reserved);
    expect(escaped).toBe(
      reserved
        .split('')
        .map((c) => `\\${c}`)
        .join(''),
    );
  });

  it('passes plain ASCII through unchanged', () => {
    const text = 'Hello world 123 abc';
    expect(escapeMarkdownV2(text)).toBe(text);
  });

  it('passes Unicode (emoji, em-dash, polish) through unchanged', () => {
    const text = '🎯 Memphis — Wodzu wygrał. Ąść';
    // Period is reserved → expect escape on '.' only
    expect(escapeMarkdownV2(text)).toBe('🎯 Memphis — Wodzu wygrał\\. Ąść');
  });

  it('reproduces the Zawoja 2026-05-06 failure case (mixed reserved chars)', () => {
    // Sample fragment of a real proactive report that crashed Telegram with
    // "can't parse entities at byte offset 442" before this fix.
    const offending = 'Update: [tasks] _pending_ — 3 items, *5 done* (60%)';
    const escaped = escapeMarkdownV2(offending);
    expect(escaped).toBe(
      'Update: \\[tasks\\] \\_pending\\_ — 3 items, \\*5 done\\* \\(60%\\)',
    );
  });

  it('handles empty string', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });

  it('escapes backslash itself (so escaped output round-trips cleanly)', () => {
    expect(escapeMarkdownV2('a\\b')).toBe('a\\\\b');
  });
});
