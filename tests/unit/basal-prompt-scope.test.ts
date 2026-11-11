import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  BASAL_PROMPT_SCOPE_CUES,
  basalPromptMayNeedActionableIntent,
} from '../../src/gateway/basal-prompt-classification.js';

const contract = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/basal-prompt-scope.json'), 'utf8'),
) as {
  cues: string[];
  cases: { id: string; input: string; gated: boolean }[];
};

it('exposes exactly the cue table the shared contract pins', () => {
  expect([...BASAL_PROMPT_SCOPE_CUES].sort()).toEqual([...contract.cues].sort());
});

it.each(contract.cases)('gates $id as expected', ({ input, gated }) => {
  expect(basalPromptMayNeedActionableIntent(input)).toBe(gated);
});

it('matches the cue case-insensitively', () => {
  expect(basalPromptMayNeedActionableIntent('ZAPAMIĘTAJ, że tak')).toBe(true);
  expect(basalPromptMayNeedActionableIntent('Co UsTaliliśmy?')).toBe(true);
});
