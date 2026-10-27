"""Corrupted corpus fixtures must fail before any optional ML stack is loaded."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

TRAINING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TRAINING))
from kartograf_train.corpus_contract import CorpusContractError, ZONE_LABELS, validate_corpus

spec = importlib.util.spec_from_file_location("corpus_builder_contract_tests", TRAINING / "kartograf-corpus.py")
builder = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = builder
spec.loader.exec_module(builder)


class CorpusContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memphis-corpus-contract-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rows = {}
        self.pairs = {}
        for split in ("train", "eval"):
            rows = []
            for i in range(6):
                text = f"synthetic {split} fixture content item {i}"
                rows.append({"content": text, "sha256": hashlib.sha256(text.encode()).hexdigest(),
                             "zone": "journal" if i < 3 else "cases",
                             "source_path": f"synthetic/{split}/{i}", "license": "operator:local-only"})
            self.rows[split] = rows
            self.pairs[split] = [{"anchor_sha256": rows[0]["sha256"],
                                  "positive_sha256": rows[1]["sha256"],
                                  "hard_negatives_sha256": [rows[3]["sha256"]]}]
        self.labels = list(ZONE_LABELS)
        self.write()

    def write(self):
        (self.root / "zone-labels.json").write_text(json.dumps(self.labels))
        (self.root / "corpus-v1-summary.json").write_text(json.dumps({
            "secret_scan": {"clean": True}, "vault_denylist": {"enforced": True},
            "split": {key: len(rows) for key, rows in self.rows.items()},
            "source_count": sum(len(rows) for rows in self.rows.values()),
        }))
        (self.root / "license-audit.json").write_text(json.dumps({
            row["source_path"]: {"sha256": row["sha256"], "license": row["license"]}
            for rows in self.rows.values() for row in rows
        }))
        for split, rows in self.rows.items():
            (self.root / f"{split}.jsonl").write_text("\n".join(json.dumps(row) for row in rows) + "\n")
            name = "pairs.jsonl" if split == "train" else "eval-pairs.jsonl"
            (self.root / name).write_text("\n".join(json.dumps(pair) for pair in self.pairs[split]) + "\n")

    def test_clean_disjoint_pairs_are_validated_from_actual_files(self):
        result = validate_corpus(self.root, require_pairs=True, require_eval=True)
        self.assertEqual(result["split"], {"train": 6, "eval": 6})
        self.assertEqual(result["pair_counts"], {"train": 1, "eval": 1})
        self.assertEqual(result["train_eval_overlap"], 0)

    def test_same_count_reordered_zone_schema_is_rejected(self):
        self.labels[10] = "messages"
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "ordering"):
            validate_corpus(self.root)

    def test_duplicate_content_cannot_cross_the_split(self):
        self.rows["eval"][0] = self.rows["train"][0].copy()
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "overlap"):
            validate_corpus(self.root)

    def test_duplicate_inside_split_is_not_silently_deduplicated_by_loader(self):
        self.rows["train"].append(self.rows["train"][0].copy())
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "Duplicate"):
            validate_corpus(self.root)

    def test_content_hash_is_recomputed(self):
        self.rows["train"][0]["content"] += " changed"
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "hash mismatch"):
            validate_corpus(self.root)

    def test_clean_summary_cannot_hide_a_postbuild_credential(self):
        text = 'access_token = "' + 'syntheticPrivateSentinel123456' + '"'
        row = self.rows["train"][0]
        row.update(content=text, sha256=hashlib.sha256(text.encode()).hexdigest())
        self.write()
        with self.assertRaises(CorpusContractError) as failure:
            validate_corpus(self.root)
        self.assertNotIn("syntheticPrivateSentinel", str(failure.exception))

    def test_pairs_cannot_reference_another_split(self):
        self.pairs["train"][0]["positive_sha256"] = self.rows["eval"][0]["sha256"]
        self.write()
        with self.assertRaises(CorpusContractError):
            validate_corpus(self.root, require_pairs=True)

    def test_pair_self_positive_is_rejected(self):
        pair = self.pairs["train"][0]
        pair["positive_sha256"] = pair["anchor_sha256"]
        self.write()
        with self.assertRaises(CorpusContractError):
            validate_corpus(self.root, require_pairs=True)

    def test_hard_negatives_cannot_have_the_anchor_zone(self):
        self.pairs["train"][0]["hard_negatives_sha256"] = [self.rows["train"][2]["sha256"]]
        self.write()
        with self.assertRaises(CorpusContractError):
            validate_corpus(self.root, require_pairs=True)

    def test_mixed_negative_counts_are_rejected_before_batching(self):
        rows = self.rows["train"]
        self.pairs["train"].append({"anchor_sha256": rows[1]["sha256"],
                                    "positive_sha256": rows[2]["sha256"],
                                    "hard_negatives_sha256": [rows[3]["sha256"], rows[4]["sha256"]]})
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "Mixed"):
            validate_corpus(self.root, require_pairs=True)

    def test_ambiguous_pair_members_are_not_treated_as_verified_labels(self):
        self.rows["train"][1]["ambiguous"] = True
        self.write()
        with self.assertRaisesRegex(CorpusContractError, "ambiguous"):
            validate_corpus(self.root, require_pairs=True)

    def test_license_provenance_cannot_disagree_with_a_row(self):
        (self.root / "license-audit.json").write_text("{}")
        with self.assertRaisesRegex(CorpusContractError, "license provenance"):
            validate_corpus(self.root)

    def test_symlinked_metadata_is_not_read(self):
        path = self.root / "zone-labels.json"
        target = self.root / "external.json"
        path.rename(target)
        path.symlink_to(target)
        with self.assertRaisesRegex(CorpusContractError, "regular local files"):
            validate_corpus(self.root)

    def test_summary_counts_are_checked(self):
        self.rows["train"].pop()
        (self.root / "train.jsonl").write_text("\n".join(json.dumps(r) for r in self.rows["train"]))
        with self.assertRaisesRegex(CorpusContractError, "counts"):
            validate_corpus(self.root)


class CorpusBuilderTests(unittest.TestCase):
    def sample(self, path, text, zone="journal", license="repo:apache-2.0"):
        return builder.Sample(path, text, zone, 0.5, hashlib.sha256(text.encode()).hexdigest(), license, False)

    def test_frozen_labels_align_with_runtime_despite_extra_chain_names(self):
        builder._assert_zone_catalog_alignment(TRAINING.parent.parent)

    def test_dedupe_precedes_split_and_conflicting_labels_are_removed(self):
        samples = [self.sample("a", "same"), self.sample("b", "same"),
                   self.sample("c", "conflict"), self.sample("d", "conflict", "cases")]
        unique, duplicates, conflicts = builder._deduplicate_samples(samples)
        self.assertEqual((len(unique), duplicates, conflicts), (1, 1, 2))

    def test_private_alias_is_never_upgraded_to_a_public_license(self):
        unique, _, _ = builder._deduplicate_samples([
            self.sample("a", "same"), self.sample("private", "same", license="operator:local-only")])
        self.assertEqual(unique[0].license, "operator:local-only")

    def test_split_is_order_independent_and_content_disjoint(self):
        samples = [self.sample(str(i), f"unique item {i}", "journal" if i < 20 else "cases")
                   for i in range(40)]
        left = builder._split_samples(samples, 42)
        right = builder._split_samples(list(reversed(samples)), 42)
        hashes = lambda rows: [row.sha256 for row in rows]
        self.assertEqual([hashes(rows) for rows in left], [hashes(rows) for rows in right])
        self.assertFalse(set(hashes(left[0])) & set(hashes(left[1])))
        self.assertEqual(len(left[1]), 8)

    def test_tracked_sources_exclude_untracked_content(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "src").mkdir()
            (root / "src/tracked.ts").write_text("synthetic harmless source")
            (root / "src/untracked.ts").write_text("synthetic local source")
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            subprocess.run(["git", "-C", str(root), "add", "src/tracked.ts"], check=True)
            self.assertEqual(list(builder._expand_repo_allowlist(root)), [root / "src/tracked.ts"])

    def test_symlink_to_protected_storage_is_rejected_before_reading(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "src").mkdir()
            (root / ".memphis").mkdir()
            target = root / ".memphis/vault-entries.json"
            target.write_text("synthetic fixture only")
            path = root / "src/leak.ts"
            path.symlink_to(target)
            with patch.object(builder, "_read_text", side_effect=AssertionError("must not read")):
                sample, hit = builder._build_repo_sample(root, path, 0, [root])
            self.assertIsNone(sample)
            self.assertEqual(hit.pattern, "denylist-symlink")
            self.assertTrue(builder._is_denied(str(target)))

    def test_existing_output_is_rejected_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "marker").write_text("keep")
            args = SimpleNamespace(repo_root=temp, chains_dir=None, data_root=None,
                                   out_dir=temp, dry_run=False)
            with self.assertRaisesRegex(SystemExit, "already exists"):
                builder.build_corpus(args)
            self.assertEqual((root / "marker").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
