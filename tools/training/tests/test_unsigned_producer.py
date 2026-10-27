"""Release boundary tests: synthetic artifacts, no ML downloads or real keys."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

TRAINING = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TRAINING))
spec = importlib.util.spec_from_file_location("kartograf_harness", TRAINING / "train-kartograf.py")
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class UnsignedProducerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="memphis-unsigned-producer-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.corpus = self.root / "corpus"
        self.corpus.mkdir()
        (self.corpus / "train.jsonl").write_text('{}\n')
        (self.corpus / "corpus-v1-summary.json").write_text(json.dumps({
            "source_count": 1, "corpus_version": "synthetic", "secret_scan": {"clean": True},
            "vault_denylist": {"enforced": True},
        }))
        self.out = self.root / "output"
        self.base = ["trainer", "--corpus", str(self.corpus), "--out", str(self.out)]

    def invoke(self, extra):
        with patch.object(sys, "argv", self.base + extra), contextlib.redirect_stderr(io.StringIO()):
            return harness.main()

    def test_unsigned_stub_needs_no_crypto_or_seed_and_cannot_be_mistaken_for_signed_checkpoint(self):
        with patch.object(harness, "ed25519_sign", side_effect=AssertionError("no signing")):
            self.assertEqual(self.invoke(["--mode", "stub", "--unsigned"]), 0)
        metadata = json.loads((self.out / "unsigned-checkpoint.json").read_text())
        self.assertNotIn("signature", metadata)
        self.assertNotIn("signer_did", metadata)
        self.assertFalse((self.out / "checkpoint.json").exists())
        self.assertEqual((self.out / "unsigned-checkpoint.json").stat().st_mode & 0o777, 0o600)
        before = (self.out / "model.onnx").read_bytes()
        with self.assertRaisesRegex(SystemExit, "already exist"):
            self.invoke(["--unsigned"])
        self.assertEqual((self.out / "model.onnx").read_bytes(), before)

    def test_real_training_rejects_seed_files_and_unpinned_revisions_before_loading_anything(self):
        with patch.object(harness, "_run_training", side_effect=AssertionError("must not train")) as training:
            for extra in [
                ["--mode", "full", "--signing-seed-file", "/nonexistent/synthetic-seed"],
                ["--mode", "full", "--unsigned"],
                ["--mode", "smoke", "--unsigned", "--base-model", "example/model@main"],
            ]:
                with self.subTest(extra=extra), self.assertRaises(SystemExit) as failure:
                    self.invoke(extra)
                self.assertEqual(failure.exception.code, 2)
            training.assert_not_called()
        self.assertFalse(self.out.exists())

    def test_real_mode_metadata_and_training_use_the_same_pinned_source_without_signing(self):
        source = "example/model@" + "a" * 40
        result = {"onnx_bytes": b"synthetic-export", "tokenizer_bytes": b"{}",
                  "onnx_sha": harness.sha256_hex(b"synthetic-export"),
                  "tokenizer_sha": harness.sha256_hex(b"{}"),
                  "steps": 5, "eval_recall_at_10": 0.6, "loaded_precision": "synthetic"}
        with patch.object(harness, "_run_training", return_value=result) as training:
            self.assertEqual(self.invoke(["--mode", "full", "--unsigned", "--base-model", source]), 0)
            training.assert_called_once_with("full", self.corpus, self.out, source)
        metadata = json.loads((self.out / "unsigned-checkpoint.json").read_text())
        self.assertEqual(metadata["base_model"], source)
        self.assertEqual(metadata["training_provenance"]["steps"], 5)
        self.assertFalse((self.out / "checkpoint.json").exists())

    def test_training_config_receives_the_pinned_model_and_revision(self):
        config_factory = Mock(side_effect=lambda **kwargs: SimpleNamespace(**kwargs))
        result = SimpleNamespace(steps=1, first_loss=1.0, final_loss=0.5, loaded_precision="synthetic",
                                 dataset_size=1, trainable_params=1, total_params=1,
                                 onnx_bytes=b"test", tokenizer_json_bytes=b"{}", onnx_sha256="a" * 64,
                                 tokenizer_sha256="b" * 64,
                                 eval_results=SimpleNamespace(retrieval_recall_at_10=0.5))
        fake = SimpleNamespace(TrainConfig=config_factory, run=Mock(return_value=result))
        with patch.dict(sys.modules, {"kartograf_train.train": fake}), \
             patch.object(harness, "_check_transformers_modernbert_support"), \
             contextlib.redirect_stderr(io.StringIO()):
            harness._run_training("full", self.corpus, self.out, "example/model@" + "a" * 40)
        config = fake.run.call_args.args[0]
        self.assertEqual(config.model_id, "example/model")
        self.assertEqual(config.model_revision, "a" * 40)


if __name__ == "__main__":
    unittest.main()
