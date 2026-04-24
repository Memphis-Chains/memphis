"""Dataset + DataLoader + class-balanced sampler + pair hydration.

Reads the corpus produced by kartograf-corpus.py + pairs.jsonl produced
by kartograf-pair-miner.py. Dedupes by sha256, drops ambiguous=true
samples (Phase 1.5 can relabel them via teacher distillation), and
emits per-anchor batches of (anchor, positive, K hard_negs) tensors.
"""
from __future__ import annotations

import json
import math
import random
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import torch
from torch.utils.data import Dataset, DataLoader, WeightedRandomSampler

# Mirror of the zone taxonomy. Kept in sync with
# tools/training/kartograf-corpus.py::ZONES and
# src/memory/chain-catalog.ts::CHAIN_CATALOG by the corpus builder
# asserting the alignment at build time; here we only need the order.
ZONES = [
    "journal", "decisions", "reflections", "cases", "patterns",
    "system", "collective", "proactive", "insights", "soul",
    "reserved_1", "reserved_2",
]
ZONE_TO_IDX = {z: i for i, z in enumerate(ZONES)}


@dataclass
class Sample:
    sha256: str
    source_path: str
    zone: str
    content: str
    zone_idx: int


@dataclass
class CorpusBundle:
    """Everything the training loop needs from on-disk corpus artifacts.

    - `anchor_samples`: sha-deduped, zone-ok, pair-covered, non-ambiguous
      (unless drop_ambiguous=False). This is the `len(dataset)` set.
    - `samples_by_sha`: ALL known samples (including ambiguous + those
      with no outgoing pair) — needed because pairs.jsonl's positives
      and hard negatives can reference samples outside the anchor set.
    - `pairs_by_sha`: anchor_sha -> pair dict from pairs.jsonl.
    """
    anchor_samples: list[Sample]
    samples_by_sha: dict[str, Sample]
    pairs_by_sha: dict[str, dict]
    ambiguous_shas: set[str]


def load_corpus(
    corpus_dir: Path,
    drop_ambiguous: bool = True,
) -> CorpusBundle:
    """Load train.jsonl (dedupe by sha256) + pairs.jsonl.

    Returns a CorpusBundle; see its docstring for the anchor vs full
    sample distinction.
    """
    train_path = corpus_dir / "train.jsonl"
    pairs_path = corpus_dir / "pairs.jsonl"
    if not train_path.exists():
        raise FileNotFoundError(f"train.jsonl missing at {train_path}")
    if not pairs_path.exists():
        raise FileNotFoundError(
            f"pairs.jsonl missing at {pairs_path}. Run "
            f"tools/training/kartograf-pair-miner.py first."
        )

    pairs_by_sha: dict[str, dict] = {}
    with pairs_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            p = json.loads(line)
            pairs_by_sha[p["anchor_sha256"]] = p

    # Load ALL samples into the map — pairs.jsonl references samples
    # by sha256 regardless of ambiguity, so filtering at load time
    # breaks positive/neg lookups downstream. We track ambiguity
    # separately and apply it when choosing which samples are valid
    # *anchors*.
    samples: dict[str, Sample] = {}
    ambiguous_shas: set[str] = set()
    with train_path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            sha = obj["sha256"]
            if sha in samples:
                # Content-duplicate; corpus has many cyclic system-chain
                # messages. Keep the first (earliest block idx or
                # earliest file traversal), which is what pair miner
                # used as the canonical representative.
                continue
            if obj["zone"] not in ZONE_TO_IDX:
                raise ValueError(
                    f"unknown zone {obj['zone']!r} in corpus — "
                    f"zone taxonomy drift"
                )
            if obj.get("ambiguous", False):
                ambiguous_shas.add(sha)
            samples[sha] = Sample(
                sha256=sha,
                source_path=obj["source_path"],
                zone=obj["zone"],
                content=obj["content"],
                zone_idx=ZONE_TO_IDX[obj["zone"]],
            )

    # Anchor set: has a pair AND (unless --keep-ambiguous) is not flagged
    # ambiguous. Ambiguous samples still serve as positives / negatives
    # for other anchors — their content is real, just the zone label
    # hasn't been verified by the teacher. The pair miner doesn't care;
    # the trainer only refuses to use ambiguous zone labels in CE.
    anchor_samples = [
        s for s in samples.values()
        if s.sha256 in pairs_by_sha
        and (not drop_ambiguous or s.sha256 not in ambiguous_shas)
    ]
    print(
        f"[data] loaded {len(samples)} unique samples "
        f"({len(ambiguous_shas)} ambiguous); "
        f"{len(anchor_samples)} usable anchors with pairs",
    )
    return CorpusBundle(
        anchor_samples=anchor_samples,
        samples_by_sha=samples,
        pairs_by_sha=pairs_by_sha,
        ambiguous_shas=ambiguous_shas,
    )


def compute_class_weights(samples: list[Sample]) -> torch.Tensor:
    """Inverse-frequency weights for CE loss. Returns tensor of
    shape [num_zones]. Zero-count zones get weight 0 (ignored)."""
    counts = Counter(s.zone_idx for s in samples)
    total = sum(counts.values())
    weights = torch.zeros(len(ZONES), dtype=torch.float32)
    for z in range(len(ZONES)):
        n = counts.get(z, 0)
        if n == 0:
            # Zero-count class can't be trained; weight 0 means ignored
            # in weighted CE (and the sampler never draws it either).
            weights[z] = 0.0
        else:
            # Standard inverse-frequency, then normalize so average
            # weight ≈ 1.0 across populated classes.
            weights[z] = total / (len(ZONES) * n)
    # Clamp extreme values so a class with 2 samples doesn't dominate.
    weights = torch.clamp(weights, max=20.0)
    return weights


def build_sampler(samples: list[Sample]) -> WeightedRandomSampler:
    """Weighted sampler with per-sample weight 1/sqrt(zone_count).

    Using sqrt (rather than full inverse frequency) dampens majority
    class (system at ~88%) without over-amplifying minority classes
    to the point where training sees mostly tiny-tail zones.
    """
    counts = Counter(s.zone_idx for s in samples)
    weights = torch.tensor(
        [1.0 / math.sqrt(max(counts[s.zone_idx], 1)) for s in samples],
        dtype=torch.float32,
    )
    return WeightedRandomSampler(
        weights=weights,
        num_samples=len(samples),
        replacement=True,
    )


class KartografDataset(Dataset):
    """One training anchor per index. __getitem__ returns strings, the
    collate function tokenizes + tensorizes so we can reuse a single
    tokenizer batch call per step (not per sample)."""

    def __init__(self, bundle: CorpusBundle) -> None:
        self.anchors = bundle.anchor_samples
        self.pairs = bundle.pairs_by_sha
        self.samples_by_sha = bundle.samples_by_sha

    def __len__(self) -> int:
        return len(self.anchors)

    def __getitem__(self, idx: int) -> dict:
        anchor = self.anchors[idx]
        pair = self.pairs[anchor.sha256]
        positive_sha = pair["positive_sha256"]
        positive = self.samples_by_sha[positive_sha]
        neg_shas = pair["hard_negatives_sha256"]
        negs = [self.samples_by_sha[sha] for sha in neg_shas]
        return {
            "anchor_text": anchor.content,
            "anchor_zone_idx": anchor.zone_idx,
            "positive_text": positive.content,
            "neg_texts": [n.content for n in negs],
            "neg_count": len(negs),
            "anchor_sha": anchor.sha256,
        }


def make_collate(tokenizer, max_length: int):
    """Returns a collate_fn that tokenizes (anchor, positive, negs) for
    a batch of B items into a flat tensor batch of size B*(2+K)."""

    def collate(items: list[dict]) -> dict:
        # Assume all items in a batch have same neg_count (currently
        # fixed at 4 by the pair miner's --top-k-hard-negs).
        neg_count = items[0]["neg_count"]
        for it in items:
            if it["neg_count"] != neg_count:
                raise RuntimeError(
                    f"batch has mixed neg_count "
                    f"({it['neg_count']} vs {neg_count}); pair miner "
                    f"should emit uniform K."
                )
        # Order within each item: [anchor, positive, neg_0, ..., neg_{K-1}].
        # Flat order across batch: item0_anchor, item0_pos, item0_neg0, ...,
        # item1_anchor, item1_pos, ... . The model runs on all of them at
        # once; loss code reshapes back.
        flat_texts: list[str] = []
        zone_labels: list[int] = []
        for it in items:
            flat_texts.append(it["anchor_text"])
            flat_texts.append(it["positive_text"])
            flat_texts.extend(it["neg_texts"])
            zone_labels.append(it["anchor_zone_idx"])
        enc = tokenizer(
            flat_texts,
            padding=True,
            truncation=True,
            max_length=max_length,
            return_tensors="pt",
        )
        return {
            "input_ids": enc["input_ids"],
            "attention_mask": enc["attention_mask"],
            "zone_labels": torch.tensor(zone_labels, dtype=torch.long),
            "batch_size": len(items),
            "per_item_stride": 2 + neg_count,
            "neg_count": neg_count,
        }

    return collate


def make_dataloader(
    dataset: KartografDataset,
    tokenizer,
    batch_size: int = 1,
    max_length: int = 512,
    use_balanced_sampler: bool = True,
    seed: int = 42,
) -> DataLoader:
    """Build the DataLoader. `batch_size` counts ANCHORS per step —
    each anchor drags its positive + K hard negs, so the effective
    forward batch on the model is batch_size * (2 + K)."""
    generator = torch.Generator().manual_seed(seed)
    if use_balanced_sampler:
        sampler = build_sampler(dataset.anchors)
    else:
        sampler = torch.utils.data.RandomSampler(
            dataset, generator=generator
        )  # type: ignore[assignment]
    return DataLoader(
        dataset,
        batch_size=batch_size,
        sampler=sampler,
        collate_fn=make_collate(tokenizer, max_length),
        num_workers=0,  # tokenizer parallelism is fine; avoid fork issues
        pin_memory=torch.cuda.is_available(),
        drop_last=True,
    )
