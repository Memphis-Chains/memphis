# Q2 exit gate

Run `bash scripts/quarterly-exit-test-q2.sh` after `npm ci` and `npm run build`.
The acceptance checks follow the Q2 ship criteria in
`docs/roadmap/Y1-2026-05-to-2027-05.md`: release checkpoint installation,
active checkpoint reporting, a confident vault embedding, Kartograf cascade
tier 0, six-chain MV2 export/import, a nonempty audit report, and HF dataset
export loaded by Python's `datasets` package.

Every CLI probe receives an isolated temporary home, empty dotenv, database
and vault paths. Operator credentials and configuration are not inherited.
The signed checkpoint is installed into that fixture, never into the running
operator installation. The fixture is retained for local failure investigation.

Set `QUARTERLY_GATE_REPORT` to choose the JSON report path. The workflow uploads
that report even when acceptance fails. Each criterion has an independent
result; dependent import/loader checks identify a failed export as their blocker.
Malformed CLI output fails validation. Doctor's unrelated runtime setup checks
does not override the explicit cascade-provider assertion.

## Current readiness

Adding the missing script repairs the automation, not the Q2 deliverables.
At main `d41dc90b`, the public-release Kartograf installer is still described as
future work in `kartograf.handler.ts`, the required audit report is absent, and
the MV2 CLI accepts journal/chains/embeddings tracks rather than the six-chain
Q2 contract. The gate must remain red until the real criteria pass. A placeholder
audit, synthetic model, fallback embedding, or successful Q1 scaffold test is
not evidence that Q2 shipped.

The hosted workflow builds native/TypeScript before probing and installs
Python 3.12 with `datasets==5.1.0` (Apache-2.0, CI-only loader). Local runs need
the same loader available; a missing loader is a failed acceptance prerequisite,
not an automatic pass. No corpus exception
or network/install failure bypasses Q2 acceptance.

The test `tests/ops/quarterly-q2-gate.test.ts` supplies a synthetic CLI to test
the gate itself. Its green result proves pass/fail and isolation behavior;
it does not attest the actual model, audit, or quarter completion.
