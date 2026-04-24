"""Multi-task loss: InfoNCE (contrastive) + weighted cross-entropy (zone).

Total loss per docs/dev/KARTOGRAF-SPEC.md §Multi-task loss:

    L = λ1 * InfoNCE(anchor, positive, negatives) + λ2 * CE(zone_logits, label)

Default weights from spec: λ1=1.0, λ2=0.5. Tunable in training config.

The model forward returns a flat batch of size B*(2+K) with order
[anchor_0, positive_0, neg_0_0, ..., neg_0_{K-1}, anchor_1, ...]. This
loss module reshapes back into (B, 2+K) and computes the per-anchor
contrastive term + zone CE.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F
from dataclasses import dataclass


@dataclass
class LossOutput:
    total: torch.Tensor
    infonce: torch.Tensor
    ce: torch.Tensor


class KartografLoss(nn.Module):
    def __init__(
        self,
        class_weights: torch.Tensor,
        lambda_infonce: float = 1.0,
        lambda_ce: float = 0.5,
        temperature: float = 0.07,
    ) -> None:
        super().__init__()
        # Zero-weight zones (those with no training samples) are
        # effectively ignored — CE on them would back-propagate noise.
        # We still keep them in the output size so zone_logits stays
        # 12-class per the envelope contract.
        self.register_buffer("class_weights", class_weights.clone())
        self.lambda_infonce = lambda_infonce
        self.lambda_ce = lambda_ce
        self.temperature = temperature

    def forward(
        self,
        embeddings: torch.Tensor,  # [B*(2+K), embed_dim]
        zone_logits: torch.Tensor,  # [B*(2+K), num_zones]
        zone_labels: torch.Tensor,  # [B]
        per_item_stride: int,  # 2 + K
        neg_count: int,
    ) -> LossOutput:
        batch_size = zone_labels.shape[0]
        assert embeddings.shape[0] == batch_size * per_item_stride, (
            f"embedding batch mismatch: {embeddings.shape[0]} vs "
            f"{batch_size}*{per_item_stride}"
        )
        # Reshape to [B, 2+K, D]
        embeds = embeddings.view(batch_size, per_item_stride, -1)
        anchor_e = embeds[:, 0, :]              # [B, D]
        positive_e = embeds[:, 1, :]             # [B, D]
        neg_e = embeds[:, 2:, :]                 # [B, K, D]

        # Since embeddings are L2-normalized, dot product == cosine.
        pos_sim = (anchor_e * positive_e).sum(dim=-1, keepdim=True)    # [B, 1]
        neg_sim = torch.einsum("bd,bkd->bk", anchor_e, neg_e)          # [B, K]
        all_sim = torch.cat([pos_sim, neg_sim], dim=1) / self.temperature
        # InfoNCE: log-softmax over K+1 candidates, CE against position 0.
        infonce_labels = torch.zeros(batch_size, dtype=torch.long,
                                     device=all_sim.device)
        loss_infonce = F.cross_entropy(all_sim, infonce_labels)

        # Zone CE — only on anchor slots (stride 0 within each item).
        anchor_zone_logits = zone_logits.view(
            batch_size, per_item_stride, -1,
        )[:, 0, :]  # [B, num_zones]
        loss_ce = F.cross_entropy(
            anchor_zone_logits,
            zone_labels,
            weight=self.class_weights,
        )

        total = self.lambda_infonce * loss_infonce + self.lambda_ce * loss_ce
        return LossOutput(total=total, infonce=loss_infonce.detach(), ce=loss_ce.detach())
