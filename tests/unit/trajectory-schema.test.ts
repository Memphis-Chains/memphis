/**
 * Unit tests for the trajectory schema v1 contract
 * (docs/dev/TRAJECTORY-EXPORT-V1.md, PR "A" in the implementation
 * sequence). Pure contract tests — no chain I/O, no runtime.
 */

import { describe, expect, it } from 'vitest';

import {
  SCHEMA_VERSION,
  Trajectory,
  TrajectoryEvent,
  TrajectoryEventKind,
  ConsentLevel,
  TrajectorySurface,
  Provenance,
  toJsonSchema,
} from '../../src/trajectory/schema.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const VALID_PROVENANCE = {
  chain: 'journal',
  blockIndex: 7,
  blockHash: 'a'.repeat(64),
  prevHash: 'b'.repeat(64),
  signer: 'c'.repeat(64),
  signature: 'd'.repeat(128),
};

const MINIMAL_EVENT = {
  kind: 'user_input' as const,
  ts: '2026-04-20T12:34:56.000Z',
  turnId: 'turn-abc',
  surface: 'cli' as const,
  consent: 'exportable' as const,
  provenance: null,
  payload: { text: 'hi' },
};

const MINIMAL_TRAJECTORY = {
  schemaVersion: 1 as const,
  trajectoryId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  sessionId: 's-abc',
  agentIdentity: {
    agentName: 'Memphis',
    ownerName: 'Wodzu',
    instanceId: 'e'.repeat(64),
  },
  startedAt: '2026-04-20T12:30:00.000Z',
  completedAt: '2026-04-20T12:40:00.000Z',
  turns: 1,
  events: [MINIMAL_EVENT],
  integrity: {
    chainHashes: { journal: 'f'.repeat(64) },
    eventCount: 1,
    signedEventCount: 0,
  },
};

// ── Core shape acceptance ───────────────────────────────────────────

describe('trajectory schema v1 — Trajectory shape', () => {
  it('accepts a minimal valid trajectory', () => {
    expect(() => Trajectory.parse(MINIMAL_TRAJECTORY)).not.toThrow();
  });

  it('accepts a trajectory with provenance-backed event', () => {
    const trajectoryWithProvenance = {
      ...MINIMAL_TRAJECTORY,
      events: [
        {
          ...MINIMAL_EVENT,
          provenance: VALID_PROVENANCE,
        },
      ],
    };
    expect(() => Trajectory.parse(trajectoryWithProvenance)).not.toThrow();
  });

  it('accepts null sessionId (scheduler-driven / unbound trajectory)', () => {
    const unbound = { ...MINIMAL_TRAJECTORY, sessionId: null };
    expect(() => Trajectory.parse(unbound)).not.toThrow();
  });

  it('accepts null completedAt (in-progress trajectory)', () => {
    const inProgress = { ...MINIMAL_TRAJECTORY, completedAt: null };
    expect(() => Trajectory.parse(inProgress)).not.toThrow();
  });

  it('exposes SCHEMA_VERSION = 1', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('rejects trajectory with wrong schemaVersion', () => {
    const wrong = { ...MINIMAL_TRAJECTORY, schemaVersion: 2 };
    expect(() => Trajectory.parse(wrong)).toThrow();
  });

  it('rejects trajectory with non-UUID trajectoryId', () => {
    const wrong = { ...MINIMAL_TRAJECTORY, trajectoryId: 'not-a-uuid' };
    expect(() => Trajectory.parse(wrong)).toThrow();
  });

  it('rejects trajectory with negative turn count', () => {
    const wrong = { ...MINIMAL_TRAJECTORY, turns: -1 };
    expect(() => Trajectory.parse(wrong)).toThrow();
  });

  it('rejects trajectory with missing agentIdentity', () => {
    const incomplete: Record<string, unknown> = { ...MINIMAL_TRAJECTORY };
    delete incomplete.agentIdentity;
    expect(() => Trajectory.parse(incomplete)).toThrow();
  });
});

// ── Event kind coverage ─────────────────────────────────────────────

describe('trajectory schema v1 — TrajectoryEventKind coverage', () => {
  const kinds = [
    'user_input',
    'prompt_fragment',
    'tool_call',
    'tool_result',
    'model_response',
    'cognitive_prelude',
    'cognitive_post',
    'chain_write',
    'system_event',
  ] as const;

  for (const kind of kinds) {
    it(`accepts kind '${kind}'`, () => {
      const event = { ...MINIMAL_EVENT, kind };
      expect(() => TrajectoryEvent.parse(event)).not.toThrow();
    });
  }

  it('enum options cover the documented 9 kinds', () => {
    expect(TrajectoryEventKind.options).toHaveLength(9);
    expect([...TrajectoryEventKind.options].sort()).toEqual([...kinds].sort());
  });

  it('rejects unknown event kind', () => {
    const event = { ...MINIMAL_EVENT, kind: 'make_coffee' };
    expect(() => TrajectoryEvent.parse(event)).toThrow();
  });
});

// ── Consent levels ──────────────────────────────────────────────────

describe('trajectory schema v1 — ConsentLevel', () => {
  it('accepts the three documented levels', () => {
    for (const level of ['exportable', 'local-only', 'anonymized'] as const) {
      expect(() => ConsentLevel.parse(level)).not.toThrow();
    }
  });

  it('rejects unknown consent level', () => {
    expect(() => ConsentLevel.parse('public')).toThrow();
  });
});

// ── Surface classification ──────────────────────────────────────────

describe('trajectory schema v1 — TrajectorySurface', () => {
  it('accepts cli/http/mcp/telegram/scheduler/system', () => {
    for (const s of ['cli', 'http', 'mcp', 'telegram', 'scheduler', 'system'] as const) {
      expect(() => TrajectorySurface.parse(s)).not.toThrow();
    }
  });

  it('rejects unknown surface', () => {
    expect(() => TrajectorySurface.parse('ircd')).toThrow();
  });
});

// ── Provenance ──────────────────────────────────────────────────────

describe('trajectory schema v1 — Provenance', () => {
  it('accepts a valid provenance record', () => {
    expect(() => Provenance.parse(VALID_PROVENANCE)).not.toThrow();
  });

  it('accepts provenance with signer+signature omitted (unsigned legacy blocks)', () => {
    const unsigned = {
      chain: 'journal',
      blockIndex: 0,
      blockHash: 'a'.repeat(64),
      prevHash: 'b'.repeat(64),
    };
    expect(() => Provenance.parse(unsigned)).not.toThrow();
  });

  it('rejects provenance with missing blockHash', () => {
    const bad: Record<string, unknown> = { ...VALID_PROVENANCE };
    delete bad.blockHash;
    expect(() => Provenance.parse(bad)).toThrow();
  });

  it('rejects provenance with negative blockIndex', () => {
    const bad = { ...VALID_PROVENANCE, blockIndex: -1 };
    expect(() => Provenance.parse(bad)).toThrow();
  });
});

// ── JSON Schema export ──────────────────────────────────────────────

describe('trajectory schema v1 — toJsonSchema()', () => {
  it('produces a JSON Schema document with $schema marker', () => {
    const schema = toJsonSchema();
    expect(schema).toBeTypeOf('object');
    expect(schema.$schema).toContain('json-schema.org');
  });

  it('emits serializable JSON (no circular refs, no functions)', () => {
    const schema = toJsonSchema();
    // If this throws, the schema can't be shipped via `dist/` or consumed
    // by external validators (HuggingFace datasets, RL tooling).
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it('mentions every top-level Trajectory field somewhere in the document', () => {
    // `zod-to-json-schema` may wrap in `definitions` / use `$ref` hops —
    // we only assert that every field name the schema promises is
    // present in the serialized output, not its exact location.
    const serialized = JSON.stringify(toJsonSchema());
    for (const key of Object.keys(MINIMAL_TRAJECTORY)) {
      expect(serialized).toContain(`"${key}"`);
    }
  });

  it('mentions every TrajectoryEventKind enum value in the document', () => {
    const serialized = JSON.stringify(toJsonSchema());
    for (const kind of TrajectoryEventKind.options) {
      expect(serialized).toContain(`"${kind}"`);
    }
  });
});
