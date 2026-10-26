import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExportTrajectoriesOutput } from './exporter.js';
import { writePrivateAtomicFile } from '../infra/config/private-atomic-file.js';

/** Scalar rows avoid Arrow type collisions between heterogeneous event payloads. */
export async function writeHfTrajectoryDataset(
  targetDir: string,
  result: ExportTrajectoriesOutput,
): Promise<string[]> {
  await mkdir(join(targetDir, 'data'), { recursive: true, mode: 0o700 });
  const rows = result.trajectories.map((trajectory) => ({
    schema_version: trajectory.schemaVersion,
    trajectory_id: trajectory.trajectoryId,
    session_id: trajectory.sessionId,
    started_at: trajectory.startedAt,
    completed_at: trajectory.completedAt,
    turns: trajectory.turns,
    agent_identity_json: JSON.stringify(trajectory.agentIdentity),
    integrity_json: JSON.stringify(trajectory.integrity),
    events_json: JSON.stringify(trajectory.events),
  }));
  const dataFile = 'data/train.jsonl';
  writePrivateAtomicFile(
    join(targetDir, dataFile),
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
    { exclusive: true },
  );
  writePrivateAtomicFile(
    join(targetDir, 'README.md'),
    `---
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train.jsonl
---
# Memphis trajectory dataset

One row per consent-filtered trajectory. Decode agent_identity_json,
integrity_json and events_json with a JSON parser to recover nested values.
Nested JSON is stored as strings to preserve heterogeneous event payloads.
No dataset license is asserted: the operator controls export rights and consent.
`,
    { exclusive: true },
  );
  return [dataFile];
}
