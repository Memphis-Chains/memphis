# Resource observations in self-governance

`memphis self-governance status --json` and `memphis_self_governance_status`
include a `resources` object with a start/end timestamp and individually
sourced, instantaneous observations: host CPU over roughly 250 ms; Linux
`MemAvailable` and swap occupancy; the data-directory filesystem's available
bytes and inodes; Linux CPU, memory and I/O pressure; and NVIDIA GPU metrics
when `nvidia-smi` is available. GPU calls have a 1.5 s timeout and use no shell.

Each observation reports `observed` or `unavailable`; unsupported GPU fields
are null. Missing NVIDIA telemetry does not establish that a machine has no GPU.
The values do not establish the effective cgroup limits of the service. A
loaded model may occupy VRAM normally, and historical swap occupancy is not by
itself current memory pressure. CPU and GPU readings are short snapshots.

These observations do not alter `capable`, `canSelfRecover`, `canSelfModify` or
the existing SLO gate. They do not maintain history, estimate time to failure,
notify, restart, delete data or control admission. Collecting the observations
does not test inference, backup restoration or semantic retrieval. Historical
trends, calibrated thresholds and reversible controls are separate work.
