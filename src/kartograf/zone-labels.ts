/**
 * Canonical zone labels for the Kartograf v1 zone classifier head.
 *
 * The classifier emits 12 logits. Indices map 1:1 to the labels below in
 * the order produced by the training corpus (`zone-labels.json` written
 * by `tools/training/kartograf-pair-miner.py` during corpus build).
 *
 * Indices 0-9 align with the canonical Memphis chain catalog at the
 * training-corpus snapshot (Sprint 0.5 G2 = 10 chains pre-`messages`).
 * Indices 10-11 are reserved slots that the spec leaves for two new
 * chains without a full encoder retrain (Y2 zone-head fine-tune).
 *
 * If a future Kartograf model is trained against a different zone set
 * (e.g. v2 with `messages` promoted out of `reserved_*`), the producer
 * MUST emit a new constant here AND the runtime loader MUST verify
 * `envelope.heads_config.zone_classes === labels.length` before
 * reporting zone scores — see OnnxKartografSession.load() for the
 * runtime check.
 *
 * Source of truth: `~/.memphis/kartograf/corpus/v4/zone-labels.json`.
 * If you change anything here, mirror the change in the corpus zone
 * file (or re-train against an updated corpus) so producer + consumer
 * agree on label ordering.
 */
export const KARTOGRAF_V1_ZONE_LABELS: readonly string[] = [
  'journal',
  'decisions',
  'reflections',
  'cases',
  'patterns',
  'system',
  'collective',
  'proactive',
  'insights',
  'soul',
  'reserved_1',
  'reserved_2',
] as const;
