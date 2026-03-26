import { describe, expect, it } from 'vitest';

import { buildSystemPrompt } from '../../src/gateway/system-prompt.js';

describe('gateway system prompt', () => {
  it('uses configured agent and owner names when provided', () => {
    const prompt = buildSystemPrompt({
      agentName: 'Jawor',
      ownerName: 'Marcin',
      availableTools: ['memphis_recall', 'memphis_search', 'memphis_exec'],
    });

    expect(prompt).toContain('You are Jawor');
    expect(prompt).toContain('Your owner is Marcin.');
    expect(prompt).toContain('USER content is enclosed in <user_input> tags');
    expect(prompt).toContain('Memphis runtime policy is authoritative');
    expect(prompt).toContain('memphis_search');
  });
});
