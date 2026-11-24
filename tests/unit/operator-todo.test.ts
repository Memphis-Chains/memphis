import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  splitOperatorAddressedNote,
  updateSoulMemory,
  type SoulMemory,
} from '../../src/soul/memory.js';

/**
 * An item addressed to the OPERATOR is not the agent's task.
 *
 * Measured 2026-11-21 03:05 on this host: the operator sent the
 * one-word greeting "Yo" on Telegram. The agent burned SIXTEEN tool
 * calls (grep / exec / code_read) searching for `telegram.inbound` and
 * hit the tool-call limit, so the reply came back as the generic "I
 * stopped at the tool limit" notice.
 *
 * The cause was in the startup context the Telegram surface sends: it
 * carried a note that said "Do zrobienia dla operatora: send one
 * message to @memphisagent_bot and check 'telegram.inbound'" — inside
 * the free-text `activeWork` field, with nothing in the prompt saying
 * whose item it was. The agent read the operator's to-do as its own
 * assignment.
 *
 * This is a convention with no enforcement: "Do zrobienia dla
 * operatora" was a phrase I wrote, and a phrase is not a contract. The
 * distinction becomes structural instead — a separate field, an
 * explicit label in the prompt, and a write-time split that moves the
 * item to the right place.
 */

/** The note that actually caused the incident, verbatim in spirit. */
const INCIDENT_NOTE =
  'PR #772 scalony i wdrożony na żywo. Do zrobienia dla operatora: jedna wiadomość ' +
  'do @memphisagent_bot i sprawdzenie telegram.inbound — preview MUSI teraz pokazać treść. ' +
  'Dalej: Faza 2 Mazura.';

describe('splitting a note by recipient', () => {
  it('moves an item addressed to the operator out of the agent work', () => {
    const result = splitOperatorAddressedNote(INCIDENT_NOTE);
    expect(result.operatorTodo).toHaveLength(1);
    expect(result.operatorTodo[0]).toContain('Do zrobienia dla operatora');
    expect(result.activeWork).not.toContain('Do zrobienia dla operatora');
    expect(result.activeWork).toContain('PR #772 scalony');
    expect(result.activeWork).toContain('Dalej: Faza 2 Mazura');
  });

  it('leaves a note that merely mentions the operator alone', () => {
    const note = 'Operator asked about the Telegram preview; answering that now.';
    const result = splitOperatorAddressedNote(note);
    expect(result.operatorTodo).toEqual([]);
    expect(result.activeWork).toBe(note);
  });

  it('leaves an ordinary work note alone', () => {
    const note = 'Shipping PR #772 — waiting for the cross-arch run.';
    const result = splitOperatorAddressedNote(note);
    expect(result.operatorTodo).toEqual([]);
    expect(result.activeWork).toBe(note);
  });

  it('catches the English form', () => {
    const result = splitOperatorAddressedNote('Deploy done. For the operator: check the preview.');
    expect(result.operatorTodo).toHaveLength(1);
    expect(result.activeWork).toContain('Deploy done.');
  });

  it('catches an operator-must form', () => {
    const result = splitOperatorAddressedNote('Operator musi sprawdzić telegram.inbound.');
    expect(result.operatorTodo).toHaveLength(1);
    expect(result.activeWork).toBe('');
  });
});

describe('writing soul memory', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = join(tmpdir(), `memphis-operator-todo-${randomUUID()}`);
    mkdirSync(dataDir, { recursive: true });
    previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
    else process.env.MEMPHIS_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  // The REAL write path, not a helper: a test that calls a pure merge
  // function would not notice the merge being bypassed by the writer.
  function write(updates: Parameters<typeof updateSoulMemory>[0]): SoulMemory {
    return updateSoulMemory(updates);
  }

  it('routes an operator-addressed item to the operator list', () => {
    const memory = write({ context: { activeWork: INCIDENT_NOTE } });
    expect(memory.context.operatorTodo).toHaveLength(1);
    expect(memory.context.operatorTodo?.[0]).toContain('telegram.inbound');
    expect(memory.context.activeWork).not.toContain('Do zrobienia dla operatora');
  });

  it('keeps the agent work in the agent work field', () => {
    const memory = write({ context: { activeWork: INCIDENT_NOTE } });
    expect(memory.context.activeWork).toContain('PR #772 scalony');
  });

  it('stores an explicit operator list as given', () => {
    const memory = write({
      context: { operatorTodo: ['wyślij wiadomość do bota', 'sprawdź preview'] },
    });
    expect(memory.context.operatorTodo).toEqual(['wyślij wiadomość do bota', 'sprawdź preview']);
  });

  it('does not duplicate an operator item written twice', () => {
    write({ context: { operatorTodo: ['wyślij wiadomość do bota'] } });
    const memory = write({
      context: { operatorTodo: ['wyślij wiadomość do bota'] },
    });
    expect(memory.context.operatorTodo).toHaveLength(1);
  });

  it('does not duplicate an item moved there by a split', () => {
    write({ context: { activeWork: INCIDENT_NOTE } });
    const memory = write({
      context: {
        operatorTodo: [
          'Do zrobienia dla operatora: jedna wiadomość do @memphisagent_bot i sprawdzenie telegram.inbound — preview MUSI teraz pokazać treść.',
        ],
      },
    });
    expect(memory.context.operatorTodo).toHaveLength(1);
  });
});
