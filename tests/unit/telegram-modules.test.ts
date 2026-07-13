import { describe, expect, it } from 'vitest';

import {
  isTelegramModelProbe,
  isTelegramStatusProbe,
  isTelegramToolsProbe,
} from '../../src/gateway/channels/telegram-probes.js';
import {
  buildTelegramTtsReplyText,
  sanitizeTelegramTextForTts,
} from '../../src/gateway/channels/telegram-voice-text.js';

describe('Telegram domain modules', () => {
  it('recognizes operator probes without treating normal prompts as probes', () => {
    expect(isTelegramToolsProbe('Jakie narzędzia?')).toBe(true);
    expect(isTelegramModelProbe('context status')).toBe(true);
    expect(isTelegramStatusProbe('stan systemu')).toBe(true);
    expect(isTelegramToolsProbe('Use the tools to inspect this')).toBe(false);
  });

  it('sanitizes markdown and URLs for speech delivery', () => {
    expect(sanitizeTelegramTextForTts('**Status**: [panel](https://local.test) 🚀')).toBe(
      'Status: panel',
    );
  });

  it('limits long speech replies while retaining the full text channel separately', () => {
    expect(buildTelegramTtsReplyText('One. Two. Three. Four. Five. Six. Seven.')).toBe(
      'One. Two. Three. Four. Five. Six. Reszta w tekście.',
    );
  });
});
