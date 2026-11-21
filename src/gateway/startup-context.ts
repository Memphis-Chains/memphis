/**
 * The startup context a chat surface sends to the agent.
 *
 * WHY THIS IS A MODULE AND NOT A CLOSURE
 * ---------------------------------------
 * Measured 2026-11-21 03:05 on this host: the operator sent the
 * one-word greeting "Yo" on Telegram. The agent burned sixteen tool
 * calls (grep / exec / code_read) searching for `telegram.inbound`, hit
 * the tool-call limit, and replied with the generic "I stopped at the
 * tool limit" notice instead of answering.
 *
 * The cause was here: the context carried a note that said "Do
 * zrobienia dla operatora: ..." inside the free-text `activeWork`
 * field, and nothing said whose item it was. The agent read the
 * operator's to-do as its own assignment.
 *
 * This was inlined in a closure inside `bootstrap.ts`, which made it
 * impossible to test: a contract could only grep the source, and a
 * source grep cannot tell whether the rendering is REACHED. The first
 * version of the contract proved that — a mutation that disabled the
 * rendering entirely still passed it.
 *
 * So the rendering is a pure function here, and the contract calls it.
 */
import type { SoulMemoryContext } from '../soul/types.js';

/**
 * The operator's own to-do list, as it goes into the prompt.
 *
 * The label is the ENFORCEMENT. An item in this list belongs to the
 * operator: the agent may mention it, must not start it, and must not
 * spend its tool budget on it. A phrase in prose ("do zrobienia dla
 * operatora") was never a contract — the model cannot be expected to
 * parse Polish prose for the intended recipient.
 */
export function renderOperatorTodo(items: readonly string[]): string | undefined {
  const clean = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (clean.length === 0) return undefined;
  return (
    "Operator's own to-do (NOT your task — do not act on these unless the operator asks):\n" +
    clean.map((item) => `- ${item}`).join('\n')
  );
}

/**
 * The context section that describes what the agent is doing, plus the
 * operator's own list.
 *
 * `activeWork` is the AGENT's work. The operator's list is rendered
 * separately and labelled, so the two can never be read as one.
 */
export function renderContextSection(context: SoulMemoryContext): string[] {
  const parts: string[] = [];
  if (context.activeWork) parts.push(`Active work: ${context.activeWork}`);
  const operatorTodo = renderOperatorTodo(context.operatorTodo ?? []);
  if (operatorTodo) parts.push(operatorTodo);
  return parts;
}
