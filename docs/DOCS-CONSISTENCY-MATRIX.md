# DOCS-CONSISTENCY-MATRIX.md

## Canonical anchors

- Source-of-truth repo path: `/home/memphis_ai_brain_on_chain/memphis`
- Main reference: `CANONICAL-ARCHITECTURE.md`
- Execution mode: `EXECUTION-PLAN.md`

## Cross-doc alignment

- README.md → ✅ references canonical architecture + execution plan
- docs/README.md → ✅ indexes canonical docs and marks legacy docs clearly
- GETTING-STARTED.md → ✅ shortest operator path
- EXECUTION-PLAN.md → ✅ prioritized delivery plan
- CANONICAL-ARCHITECTURE.md → ✅ architecture source of truth

## Mismatch policy

If conflict appears:

1. Use `CANONICAL-ARCHITECTURE.md` for architecture truth.
2. Use `EXECUTION-PLAN.md` for short-horizon execution order.
3. Mark historical docs as legacy when they conflict with canonical docs.
