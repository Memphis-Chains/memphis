/**
 * Telegram MarkdownV2 escape helper.
 *
 * Telegram MarkdownV2 reserves these characters and requires backslash escape
 * when used as literal text (not as markup):
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * Use this on every interpolated string before assembling the markdown payload.
 * Static markup characters (e.g. surrounding `*` for bold) stay raw.
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */

const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(RESERVED, (ch) => `\\${ch}`);
}
