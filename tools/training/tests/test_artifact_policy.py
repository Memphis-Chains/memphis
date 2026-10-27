"""Pure stdlib release-policy regressions; no training, model download or seed."""
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from kartograf_train.artifact_policy import PLACEHOLDER_ONNX, assert_export_metrics, export_training_artifact


class ArtifactPolicyTests(unittest.TestCase):
    def test_parity_refuses_nonfinite_metrics_and_individual_bad_rows(self):
        for cosines, gap in [([float('nan')], 0), ([1], float('nan')),
                             ([1], float('inf')), ([float('inf')], 0), ([], 0),
                             ([1.0, 0.998], 0), ([1], 0.011)]:
            with self.subTest(cosines=cosines, gap=gap), self.assertRaises(ValueError):
                assert_export_metrics(cosines, gap)
        assert_export_metrics([0.999, 1.0], 0.01)

    def test_full_export_failure_aborts_and_does_not_echo_the_underlying_error(self):
        exporter = Mock(side_effect=ValueError("synthetic-private-sentinel"))
        with self.assertRaisesRegex(RuntimeError, "no deployable checkpoint") as failure:
            export_training_artifact("full", exporter, Path("/tmp/synthetic/best_state.pt"))
        self.assertNotIn("synthetic-private-sentinel", str(failure.exception))
        exporter.assert_called_once()

    def test_full_mode_refuses_empty_or_placeholder_bytes(self):
        for result in [b"", PLACEHOLDER_ONNX, "not bytes"]:
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                export_training_artifact("full", lambda: result, Path("/tmp/synthetic.pt"))

    def test_successful_export_preserves_exact_bytes(self):
        result = b"synthetic exported bytes; this test does not assert ONNX validity"
        self.assertIs(export_training_artifact("full", lambda: result, Path("/tmp/synthetic.pt")), result)

    def test_smoke_is_explicit_and_does_not_invoke_the_real_exporter(self):
        exporter = Mock(side_effect=AssertionError("must not run"))
        self.assertEqual(export_training_artifact("smoke", exporter, Path("/tmp/synthetic.pt")), PLACEHOLDER_ONNX)
        exporter.assert_not_called()


if __name__ == "__main__":
    unittest.main()
