/**
 * Trajectory export — module entry point.
 *
 * This module ships the v1 schema contract only. Exporter logic, CLI
 * commands, and runtime turnId propagation are separate follow-up PRs
 * per docs/dev/TRAJECTORY-EXPORT-V1.md implementation sequence.
 */

export {
  SCHEMA_VERSION,
  TrajectoryEventKind,
  ConsentLevel,
  TrajectorySurface,
  Provenance,
  TrajectoryEvent,
  AgentIdentity,
  TrajectoryIntegrity,
  Trajectory,
  toJsonSchema,
} from './schema.js';

export type {
  TrajectoryEventKindT,
  ConsentLevelT,
  TrajectorySurfaceT,
  ProvenanceT,
  TrajectoryEventT,
  AgentIdentityT,
  TrajectoryIntegrityT,
  TrajectoryT,
} from './schema.js';
