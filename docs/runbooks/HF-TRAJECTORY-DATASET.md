# Hugging Face trajectory dataset export

```sh
memphis export trajectories --out /private/new-dataset --format=hf-dataset --json
python3 -c 'from datasets import load_dataset; print(load_dataset("/private/new-dataset"))'
```

The format flag produces `data/train.jsonl` and a dataset card selecting that
file as the `train` split. Each row represents one consent-filtered trajectory;
scalar columns identify the trajectory, session, timestamps, turns and schema
version. Parse `agent_identity_json`, `integrity_json` and `events_json` as JSON
to recover the nested values, event payloads and chain provenance. JSON strings
preserve heterogeneous payload shapes without Arrow column-type collisions.
No license or right to distribute operator data is inferred by this format.

Use a fresh private output directory. Dataset rows and the card are created
privately without replacing existing files. A failed export can leave partial
output. Consent filtering, anonymization, time filtering and explicit all-data
confirmation use the existing trajectory exporter. The default export format
continues to produce the legacy per-trajectory JSONL with a `_meta` first line.
That legacy format is not a Hugging Face dataset.

Q2 acceptance seeds nonempty synthetic application data, loads this directory
using the pinned `datasets` loader, and verifies nonempty rows and the events
column. An empty directory or a metadata-only file cannot satisfy that check.
