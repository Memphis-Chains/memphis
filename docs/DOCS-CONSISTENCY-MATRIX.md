# DOCS-CONSISTENCY-MATRIX.md

## Canonical anchors
- Source-of-truth repo path: `/home/memphis_ai_brain_on_chain/memphis-v4`
- Main reference: `MEMPHIS-V4-CODELINE-BLUEPRINT.md`
- Execution mode: production-only + quality-first + local-first (delayed batch release)

## Cross-doc alignment
- README.md → ✅ references main blueprint + execution mode + operator pack
- WORKING-AGREEMENT.md → ✅ enforces production-only and one-command gate
- ROADMAP-V0.1.1.md → ✅ P0 tasks marked done
- ROADMAP-V0.2.0-BLUEPRINT-P0.md → ✅ execution plan with KPI/risk/rollback
- LOCAL-BIG-PACK-QUEUE.md → ✅ local-first pack queue + progress log

## Mismatch policy
If conflict appears:
1. Use `MEMPHIS-V4-CODELINE-BLUEPRINT.md` for architecture truth.
2. Use `LOCAL-BIG-PACK-QUEUE.md` for short-horizon execution order.
3. Update conflicting docs in same batch before merge.
