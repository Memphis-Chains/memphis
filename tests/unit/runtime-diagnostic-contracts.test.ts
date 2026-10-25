import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasOperatorRecovery } from '../../src/infra/runtime/operator-recovery-status.js';
import {
  isSchedulerTaskStatus,
  SCHEDULER_TASK_STATUSES,
} from '../../src/infra/runtime/scheduler-status.js';

describe('runtime diagnostic contracts', () => {
  it('recognizes every scheduler execution state and rejects unknown values', () => {
    for (const status of SCHEDULER_TASK_STATUSES) expect(isSchedulerTaskStatus(status)).toBe(true);
    for (const value of ['done', {}, undefined, 42])
      expect(isSchedulerTaskStatus(value)).toBe(false);
  });
  it('recognizes stored recovery without plaintext environment answers', () => {
    const root = mkdtempSync(join(tmpdir(), 'operator-recovery-status-'));
    const env = { MEMPHIS_DATA_DIR: root };
    try {
      mkdirSync(join(root, 'config'));
      expect(hasOperatorRecovery(env)).toBe(false);
      writeFileSync(
        join(root, 'config', 'operator.json'),
        JSON.stringify({
          passphraseHash: 'synthetic-verifier',
          salt: 'synthetic-salt',
          recoveryHash: 'synthetic-recovery-verifier',
          recoveryQuestionHint: 'fixture question',
        }),
      );
      expect(hasOperatorRecovery(env)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
