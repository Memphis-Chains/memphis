# Cognitive Models (A-E)

Memphis v5 cognitive layer has five cooperating models.

## Model A: Conscious Capture

Purpose:

- Persist explicit decisions, notes, milestones, and tagged context.

Key behavior:

- Normalizes input into chain-ready blocks.
- Writes to chain storage through the standard adapter path.

Primary value:

- Clean, structured memory foundation for all downstream models.

## Model B: Inferred Decisions

Purpose:

- Infer likely decisions from behavior patterns (commits, file changes, activity shifts).

Key behavior:

- Scores confidence per inference.
- Supports persistence of inferred decisions to decision chain.

Primary value:

- Surfaces implicit choices the user may not have explicitly logged.

## Model C: Predictive Patterns

Purpose:

- Learn from historical patterns and suggest likely next actions.

Key behavior:

- Tracks recurring decision contexts.
- Produces bounded-confidence predictions with evidence.

Primary value:

- Turns historical memory into forward-looking guidance.

## Model D: Collective Coordination

Purpose:

- Coordinate proposals and voting across local + remote agents.

Key behavior:

- Proposal lifecycle: `voting -> approved/rejected -> executed`.
- Weighted voting and consensus threshold.
- Network proposal broadcast with optional remote vote ingestion.

Primary value:

- Enables auditable multi-agent decision protocols.

## Model E: Meta-Cognitive Reflection

Purpose:

- Reflect on memory quality, blind spots, contradictions, and trends.

Key behavior:

- Daily/weekly/deep reflection modes.
- Produces actionable recommendations.
- Persists reflection artifacts to chain.

Primary value:

- Continuous self-correction and strategic learning.

## How Models Work Together

Typical flow:

1. Model A captures explicit memory.
2. Model B infers hidden decisions.
3. Model C predicts likely next moves.
4. Model D coordinates collective decisions when needed.
5. Model E reflects on outcomes and feeds improved behavior back into the loop.
