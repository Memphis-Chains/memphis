import { describe, expect, it } from 'vitest';

import { renderContextSection, renderOperatorTodo } from '../../src/gateway/startup-context.js';

/**
 * The chat surface must not hand the agent the operator's to-do list as
 * its own assignment.
 *
 * Measured 2026-11-21 03:05 on this host: the operator sent the
 * one-word greeting "Yo" on Telegram. The agent burned sixteen tool
 * calls (grep / exec / code_read) searching for `telegram.inbound`, hit
 * the tool-call limit, and replied with the generic "I stopped at the
 * tool limit" notice instead of answering.
 *
 * The cause was in the context the Telegram surface sends: a note that
 * said "Do zrobienia dla operatora: ..." sat in the free-text
 * `activeWork` field, and nothing in the prompt said whose item it was.
 *
 * This contract calls the RENDERING, it does not grep the source. The
 * first version grepped `bootstrap.ts` — and a mutation that disabled
 * the rendering entirely still passed it, because the source still
 * mentioned the field. A source grep cannot tell whether the code is
 * REACHED; a call can.
 */
describe('the operator to-do prompt contract', () => {
  it('labels the operator list as not the agent task', () => {
    const rendered = renderOperatorTodo(['wyślij wiadomość do bota']);
    expect(rendered).toContain("Operator's own to-do");
    expect(rendered).toMatch(/NOT your task/i);
  });

  it('renders nothing when the operator has no to-do', () => {
    expect(renderOperatorTodo([])).toBeUndefined();
    expect(renderOperatorTodo(['', '   '])).toBeUndefined();
  });

  it('keeps the agent work and the operator list in SEPARATE lines', () => {
    const parts = renderContextSection({
      activeWork: 'Shipping the homeostat PR.',
      recentDecisions: [],
      operatorTodo: ['wyślij wiadomość do bota'],
    });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('Shipping the homeostat PR.');
    expect(parts[0]).not.toContain('wyślij wiadomość');
    expect(parts[1]).toContain('wyślij wiadomość do bota');
  });

  it('renders only the agent work when the operator has no list', () => {
    const parts = renderContextSection({
      activeWork: 'Shipping the homeostat PR.',
      recentDecisions: [],
    });
    expect(parts).toEqual(['Active work: Shipping the homeostat PR.']);
  });

  it('renders the operator list even without any agent work', () => {
    const parts = renderContextSection({
      recentDecisions: [],
      operatorTodo: ['wyślij wiadomość do bota'],
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain('wyślij wiadomość do bota');
  });
});
