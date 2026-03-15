# Queue Resume Policy Runbook

## Purpose

Define how MemphisOS handles recovered pending tasks after restart.

## Controls

- `MEMPHIS_QUEUE_RESUME_POLICY=keep|fail|redispatch`
- `MEMPHIS_QUEUE_MODE=financial|standard`

## Policy Semantics

- `keep`: keep recovered tasks pending for manual/operator handling.
- `fail`: mark recovered tasks as failed on startup.
- `redispatch`: attempt automatic replay of recovered tasks through orchestration.

## Safe-Mode Override

If `MEMPHIS_SAFE_MODE=true` and `MEMPHIS_QUEUE_RESUME_POLICY=redispatch`, startup enforces `keep` to prevent execution while in recovery mode.

## Mode Expectations

- `financial`:
  - Use `keep` or tightly controlled `fail`.
  - Avoid blind `redispatch` for side-effectful tasks unless idempotency is proven.
  - Keep WAL durability strict (`fsync` on enqueue ack path).
- `standard`:
  - `redispatch` is acceptable for low-risk tasks.
  - Throughput-first tradeoff is acceptable with bounded retries and observability.

## Runtime Verification

Use `GET /v1/ops/status` and inspect:

- `queue.resumePolicy`: configured default policy.
- `queue.lastResume`: most recent resume run summary (`policy`, counts, `errors`, `completedAt`).

Also verify startup audit event `queue.resume.startup` in security logs.
