/**
 * Pin behavior of MiniMax inline-toolcall parser across BOTH wrapper
 * forms it has been observed emitting. Operator session 2026-05-05
 * caught the parser missing the symmetric-namespaced form — bot
 * said "Tworzę teraz plik HTML" but emitted
 *
 *   <minimax:tool_call>
 *     <invoke name="memphis_fs_write">…
 *   </minimax:tool_call>
 *
 * which the regex (`<toolcall>` only) didn't catch → XML lands as
 * plain text in the Telegram message, no file ever gets written,
 * operator asks "i?" twice. Fix accepts either opening tag.
 */
import { describe, expect, it } from 'vitest';

import { __parseMiniMaxInlineToolCallsForTests as parse } from '../../src/providers/index.js';

describe('parseMiniMaxInlineToolCalls', () => {
  it('parses the asymmetric form (<toolcall> opening, namespaced closing)', () => {
    const content = `Sprawdzam.

<toolcall>
<invoke name="memphis_exec">
<parameter name="command">ls -la</parameter>
</invoke>
</minimax:tool_call>

Wyniki niżej.`;

    const { calls, cleaned } = parse(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('memphis_exec');
    expect(calls[0].arguments).toEqual({ command: 'ls -la' });
    expect(cleaned).toContain('Sprawdzam');
    expect(cleaned).toContain('Wyniki niżej');
    expect(cleaned).not.toContain('<toolcall>');
    expect(cleaned).not.toContain('<invoke');
  });

  it('parses the symmetric namespaced form (<minimax:tool_call> on both ends) — 2026-05-05 fix', () => {
    const content = `Tworzę teraz plik HTML:

<minimax:tool_call>
<invoke name="memphis_fs_write">
<parameter name="path">/tmp/test.html</parameter>
<parameter name="content"><!DOCTYPE html><html><body>hi</body></html></parameter>
</invoke>
</minimax:tool_call>

Plik gotowy.`;

    const { calls, cleaned } = parse(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('memphis_fs_write');
    expect(calls[0].arguments).toMatchObject({
      path: '/tmp/test.html',
    });
    expect(cleaned).toContain('Tworzę teraz plik HTML');
    expect(cleaned).toContain('Plik gotowy');
    expect(cleaned).not.toContain('<minimax');
    expect(cleaned).not.toContain('<invoke');
  });

  it('parses multiple inline tool calls in one reply', () => {
    const content = `Robię dwa kroki.

<minimax:tool_call>
<invoke name="memphis_journal">
<parameter name="content">step 1</parameter>
</invoke>
</minimax:tool_call>

<toolcall>
<invoke name="memphis_journal">
<parameter name="content">step 2</parameter>
</invoke>
</minimax:tool_call>

Done.`;

    const { calls, cleaned } = parse(content);
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments).toEqual({ content: 'step 1' });
    expect(calls[1].arguments).toEqual({ content: 'step 2' });
    expect(cleaned).toContain('Robię dwa kroki');
    expect(cleaned).toContain('Done');
  });

  it('returns no calls + unchanged content when no XML wrapper present', () => {
    const content = 'Cześć, tylko zwykły tekst.';
    const { calls, cleaned } = parse(content);
    expect(calls).toHaveLength(0);
    expect(cleaned).toBe(content);
  });

  it('drops malformed block but does not echo the XML back into cleaned content', () => {
    const content = `Próba.

<minimax:tool_call>
this is not a valid <invoke> block
</minimax:tool_call>

Reszta tekstu.`;

    const { calls, cleaned } = parse(content);
    expect(calls).toHaveLength(0);
    expect(cleaned).not.toContain('<minimax:tool_call>');
    expect(cleaned).not.toContain('this is not a valid');
    expect(cleaned).toContain('Próba');
    expect(cleaned).toContain('Reszta tekstu');
  });

  it('handles parameters whose values contain XML-like content (e.g. HTML body)', () => {
    // Real-world from the 2026-05-05 incident — the file content was
    // an HTML document, which itself has < > / characters. The regex
    // is non-greedy + bounded by </parameter> so this should still
    // parse cleanly.
    const content = `<minimax:tool_call>
<invoke name="memphis_fs_write">
<parameter name="path">/tmp/x.html</parameter>
<parameter name="content"><!DOCTYPE html>
<html><body><p>Hello & goodbye</p></body></html></parameter>
</invoke>
</minimax:tool_call>`;

    const { calls } = parse(content);
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments.path).toBe('/tmp/x.html');
    const html = calls[0].arguments.content as string;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<p>Hello & goodbye</p>');
  });
});
