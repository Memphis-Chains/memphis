# Cognitive Report Triage

Use this runbook during incident/debug triage when validating journal blocks emitted by cognitive CLI save flows.

## 1. Query Latest Reports (Recommended)

```bash
npm run -s ops:query-cognitive-reports -- --json --limit 20
```

Optional targeted query:

```bash
npm run -s ops:query-cognitive-reports -- --json --type categorize
```

Live watch mode (text output):

```bash
npm run -s ops:query-cognitive-reports -- --watch --type categorize --limit 5 --interval-ms 2000
```

Live watch mode (NDJSON output for stream consumers):

```bash
npm run -s ops:query-cognitive-reports -- --watch --ndjson --type categorize --limit 5 --interval-ms 2000
```

## 2. Locate Latest `categorize_report` Manually

```bash
jq -c 'select(.data.type=="categorize_report") | {index, timestamp, source:.data.source, input:.data.report.input}' \
  "$MEMPHIS_DATA_DIR/chains/journal"/*.json | tail -n 1
```

Expected:

- `data.type` = `categorize_report`
- `data.schemaVersion` = `1`
- `data.source` = `cli.categorize`
- `data.report.input` present
- `data.report.suggestion` present

## 3. Expected Payload Shape

```json
{
  "data": {
    "type": "categorize_report",
    "schemaVersion": 1,
    "source": "cli.categorize",
    "content": "Categorize Report: <n> tag(s) suggested for input",
    "tags": ["categorize", "report"],
    "report": {
      "generatedAt": "2026-03-13T09:00:00.000Z",
      "input": "Prepare release checklist",
      "suggestion": {
        "tags": [{ "tag": "project:release", "confidence": 0.78, "category": "project" }],
        "overallConfidence": 0.78,
        "processingTimeMs": 12,
        "method": "hybrid"
      }
    }
  }
}
```

## 4. Triage Checks

1. Confirm `report.generatedAt` is valid ISO timestamp.
2. Confirm `report.input` matches operator command input.
3. Confirm `report.suggestion.tags` is an array (possibly empty, but present).
4. Confirm `data.schemaVersion` is present and currently equals `1`.
5. Confirm `savedBlock.chain=journal` in CLI JSON response when `--save` is used.
6. Validate query output contract against fixture: `tests/fixtures/cognitive-report-query/output-contract.json`.
7. If payload shape is invalid, treat as regression and run CLI save regression tests.
