/**
 * Verifies the "Unknown command" error includes actionable hints:
 * - For a verb-first mistake (e.g. `memphis add provider`), name the
 *   correct `<noun> <verb>` shapes so the operator can copy/paste
 * - For a typo (e.g. `vualt`), name close matches via Levenshtein
 *
 * Operator log 2026-04-26: ran `memphis add provider minimax`, got
 * just "Unknown command: add" with no path forward.
 */

import { describe, expect, it } from 'vitest';

import { buildUnknownCommandMessage } from '../../src/infra/cli/dispatcher.js';

describe('Unknown-command hint builder', () => {
  it('hints noun-first shape when operator types a verb (add)', () => {
    const msg = buildUnknownCommandMessage('add');
    expect(msg).toContain('Unknown command: add');
    expect(msg).toContain('memphis vault add');
    expect(msg).toContain('memphis provider add');
    expect(msg).toContain('memphis help');
  });

  it('hints noun-first shape for `remove`', () => {
    const msg = buildUnknownCommandMessage('remove');
    expect(msg).toContain('memphis vault remove');
  });

  it('suggests close matches for typos (vualt → vault)', () => {
    const msg = buildUnknownCommandMessage('vualt');
    expect(msg).toContain('Did you mean');
    expect(msg).toContain('vault');
  });

  it('suggests close matches for typos (asj → ask)', () => {
    const msg = buildUnknownCommandMessage('asj');
    expect(msg).toContain('ask');
  });

  it('falls through with just the help pointer when nothing matches', () => {
    const msg = buildUnknownCommandMessage('xyzpdq-no-match');
    expect(msg).toContain('Unknown command: xyzpdq-no-match');
    expect(msg).toContain('memphis help');
    // No "Did you mean" line when we have no candidates
    expect(msg).not.toContain('Did you mean');
  });
});
