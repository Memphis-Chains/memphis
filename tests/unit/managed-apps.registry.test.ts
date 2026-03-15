import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { executeManagedAppAction, getManagedAppManifest } from '../../src/modules/apps/manifest.js';
import {
  getManagedAppRegistryRecord,
  recordManagedAppExecution,
} from '../../src/modules/apps/registry.js';

describe('managed app registry', () => {
  it('records successful applied actions as installed app state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-app-registry-'));
    const manifestPath = join(dir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app',
          actions: {
            start: {
              summary: 'start demo app',
              steps: ['printf started'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const rawEnv = { MEMPHIS_DATA_DIR: dir } as NodeJS.ProcessEnv;
    const ref = getManagedAppManifest({ file: manifestPath, rawEnv });
    const result = executeManagedAppAction(ref, 'start', { rawEnv, apply: true });
    const record = recordManagedAppExecution(ref, result, rawEnv);

    expect(record.installed).toBe(true);
    expect(record.state).toBe('running');
    expect(getManagedAppRegistryRecord('demo-app', rawEnv)?.lastAction).toBe('start');
  });
});
