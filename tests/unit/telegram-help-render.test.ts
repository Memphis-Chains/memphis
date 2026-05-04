/**
 * Sprint E Phase 2 — Telegram `/help <tool-name>` rendering.
 *
 * Pin the format the bot replies with when an operator types
 * `/help memphis_journal` (or any registered tool name). The renderer
 * is extracted from the bot wiring so we can assert formatting
 * without spinning up a grammy Bot instance.
 *
 * Resolution priority matches the CLI `memphis tools describe` and
 * MCP server description fields (see `getToolDescription`):
 *   1. `helpText` (rich, multi-sentence) — preferred when present
 *   2. `description` (one-line) — fallback for unmigrated tools
 *
 * `cliFlags` block rendered when non-empty; absent for tools without
 * declarative flags.
 */
import { describe, expect, it } from 'vitest';

import {
  renderTelegramToolHelp,
  type TelegramToolHelpInput,
} from '../../src/gateway/channels/telegram.js';

const baseTool: TelegramToolHelpInput = {
  name: 'memphis_journal',
  tier: 0,
  description: 'Save entries to journal chain',
  featureFlag: null,
};

describe('renderTelegramToolHelp', () => {
  it('renders a header with name + tier', () => {
    const out = renderTelegramToolHelp(baseTool);
    expect(out).toContain('*memphis_journal*');
    expect(out).toContain('(tier 0)');
  });

  it('prefers helpText over description when present', () => {
    const richTool: TelegramToolHelpInput = {
      ...baseTool,
      helpText:
        'Append a journal entry to the operator-private journal chain. Multi-sentence detail.',
    };
    const out = renderTelegramToolHelp(richTool);
    expect(out).toContain('Multi-sentence detail');
    // Description is the fallback path; the rich tool should NOT
    // emit the bare description string when helpText is set.
    expect(out).not.toMatch(/^Save entries to journal chain$/m);
  });

  it('falls back to description when helpText absent', () => {
    const out = renderTelegramToolHelp(baseTool);
    expect(out).toContain('Save entries to journal chain');
  });

  it('emits Flags block when cliFlags non-empty (with required marker + alias)', () => {
    const tool: TelegramToolHelpInput = {
      ...baseTool,
      cliFlags: [
        {
          name: '--content',
          alias: '-c',
          description: 'Journal entry text.',
          required: true,
        },
        {
          name: '--tags',
          description: 'Comma-separated tags.',
        },
      ],
    };
    const out = renderTelegramToolHelp(tool);
    expect(out).toContain('Flags:');
    expect(out).toContain('--content / -c');
    expect(out).toContain('Journal entry text.');
    expect(out).toContain('(required)');
    expect(out).toContain('--tags');
    // Optional flag has no `(required)` suffix
    const tagsLine = out.split('\n').find((l) => l.includes('--tags'))!;
    expect(tagsLine).not.toContain('(required)');
  });

  it('omits Flags block when cliFlags is empty or absent', () => {
    const noFlags = renderTelegramToolHelp(baseTool);
    expect(noFlags).not.toContain('Flags:');

    const emptyFlags = renderTelegramToolHelp({ ...baseTool, cliFlags: [] });
    expect(emptyFlags).not.toContain('Flags:');
  });

  it('shows feature flag line only when set', () => {
    const flagged = renderTelegramToolHelp({
      ...baseTool,
      featureFlag: 'experimental-journal',
    });
    expect(flagged).toContain('feature flag: experimental-journal');

    const unflagged = renderTelegramToolHelp(baseTool);
    expect(unflagged).not.toContain('feature flag:');
  });
});
