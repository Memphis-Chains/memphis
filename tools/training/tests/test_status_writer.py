"""Unit tests for kartograf_train.status_writer.

Run with: ``cd tools/training && python3 -m pytest tests/test_status_writer.py``
"""
from __future__ import annotations

import json
import os
import signal
import sys
import tempfile
import time
import unittest
from pathlib import Path

# Allow the test to import `kartograf_train.status_writer` whether
# invoked from the repo root or from `tools/training/`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from kartograf_train.status_writer import StatusWriter, make_status_writer


class StatusWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_path = Path(self._tmp.name)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _read(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_writes_starting_snapshot_with_pid_and_started_at_ms(self) -> None:
        target = self.tmp_path / "status.json"
        writer = StatusWriter(target)
        writer.start(mode="smoke")

        snapshot = self._read(target)
        self.assertEqual(snapshot["state"], "starting")
        self.assertEqual(snapshot["mode"], "smoke")
        self.assertEqual(snapshot["host_pid"], os.getpid())
        self.assertIsInstance(snapshot["started_at_ms"], int)

    def test_running_then_completed_preserves_mode_field(self) -> None:
        target = self.tmp_path / "status.json"
        writer = StatusWriter(target)
        writer.start(mode="smoke", total_steps=50)
        writer.running(step=10, avg_loss=1.23, last_loss=1.23, gpu_mb=512.0)
        writer.completed(
            steps=50,
            eval_recall_at_10=0.42,
            onnx_sha256="a" * 64,
            envelope_path=str(self.tmp_path / "checkpoint.json"),
        )

        snapshot = self._read(target)
        self.assertEqual(snapshot["state"], "completed")
        # Fields from earlier writes are retained via the snapshot cache.
        self.assertEqual(snapshot["mode"], "smoke")
        self.assertEqual(snapshot["total_steps"], 50)
        self.assertEqual(snapshot["steps"], 50)
        self.assertAlmostEqual(snapshot["eval_recall_at_10"], 0.42, places=6)
        self.assertIsInstance(snapshot["completed_at_ms"], int)

    def test_failed_publishes_error_and_timestamp(self) -> None:
        target = self.tmp_path / "status.json"
        writer = StatusWriter(target)
        writer.failed("torch.cuda.OutOfMemoryError")

        snapshot = self._read(target)
        self.assertEqual(snapshot["state"], "failed")
        self.assertEqual(snapshot["error"], "torch.cuda.OutOfMemoryError")
        self.assertIsInstance(snapshot["failed_at_ms"], int)

    def test_atomic_write_leaves_no_tmp_file_after_replace(self) -> None:
        target = self.tmp_path / "status.json"
        writer = StatusWriter(target)
        writer.start()
        writer.running(step=1)
        writer.completed(steps=1, eval_recall_at_10=0.0)

        self.assertTrue(target.exists())
        self.assertFalse((self.tmp_path / "status.json.tmp").exists())

    def test_make_status_writer_returns_none_for_none_path(self) -> None:
        self.assertIsNone(make_status_writer(None))

    def test_make_status_writer_returns_instance_for_path(self) -> None:
        writer = make_status_writer(self.tmp_path / "status.json")
        self.assertIsNotNone(writer)
        assert writer is not None  # narrow for type checker
        writer.start()
        self.assertTrue((self.tmp_path / "status.json").exists())

    def test_cancelled_signal_handler_writes_state_and_exits(self) -> None:
        target = self.tmp_path / "status.json"
        writer = StatusWriter(target)

        on_cancel_calls: list[str] = []

        def on_cancel(signal_name: str) -> None:
            on_cancel_calls.append(signal_name)

        writer.install_signal_handlers(on_cancel=on_cancel)
        try:
            with self.assertRaises(SystemExit) as ctx:
                # Inline-invoke the SIGTERM handler (don't actually
                # raise SIGTERM at the process — that would kill the
                # test runner). signal.getsignal returns the installed
                # handler we want to test.
                handler = signal.getsignal(signal.SIGTERM)
                self.assertTrue(callable(handler))
                handler(signal.SIGTERM, None)  # type: ignore[misc]
            self.assertEqual(ctx.exception.code, 130)
        finally:
            writer.uninstall_signal_handlers()

        self.assertEqual(on_cancel_calls, ["SIGTERM"])
        snapshot = self._read(target)
        self.assertEqual(snapshot["state"], "cancelled")
        self.assertEqual(snapshot["signal"], "SIGTERM")
        self.assertIsInstance(snapshot["cancelled_at_ms"], int)

    def test_install_then_uninstall_restores_prior_handlers(self) -> None:
        # Sentinel handlers so we can detect they're restored.
        sentinel_calls: list[str] = []

        def sentinel_term(_sig: int, _frame: object) -> None:
            sentinel_calls.append("term")

        def sentinel_int(_sig: int, _frame: object) -> None:
            sentinel_calls.append("int")

        original_term = signal.signal(signal.SIGTERM, sentinel_term)
        original_int = signal.signal(signal.SIGINT, sentinel_int)
        try:
            writer = StatusWriter(self.tmp_path / "status.json")
            writer.install_signal_handlers()
            writer.uninstall_signal_handlers()

            self.assertIs(signal.getsignal(signal.SIGTERM), sentinel_term)
            self.assertIs(signal.getsignal(signal.SIGINT), sentinel_int)
        finally:
            signal.signal(signal.SIGTERM, original_term)
            signal.signal(signal.SIGINT, original_int)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()


# Touched fields for type-checker hint — keeps imports honest if test
# is run as a module.
_ = time
