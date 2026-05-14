"""Status JSON writer + signal handlers for Kartograf training runs.

Used by the Memphis `/nightly` autonomous training flow. The TS side
spawns `train-kartograf.py --status-file <path>` and polls the file to
expose live progress to operator surfaces (TUI / Telegram / doctor).

States the writer emits:

  - ``starting``  — process up, before training loop entry
  - ``running``   — most recent loop step (called at the existing
                    log-cadence point inside ``train.run``)
  - ``completed`` — normal exit after eval + ONNX export
  - ``cancelled`` — SIGTERM/SIGINT received, flush attempted
  - ``failed``    — unhandled exception (best-effort; the wrapping
                    SystemExit path also writes this)

The file is written atomically (write-to-tmp → ``os.replace`` to canonical
path) so a concurrent reader on the TS side never observes a torn JSON
blob. The TS reader (``src/modules/nightly/status-file.ts`` in Phase 3)
tolerates a missing file (process hasn't written yet) or a parse-failure
read (race with the rename) — it retries once.

Importing this module has no side effects; the signal handlers are
installed only when ``StatusWriter.install_signal_handlers()`` is called.
That keeps unit tests free from global SIGTERM-handler leakage.
"""
from __future__ import annotations

import json
import os
import signal
import time
from pathlib import Path
from typing import Any, Callable, Optional


_HostStateName = str  # 'starting' | 'running' | 'completed' | 'cancelled' | 'failed'


class StatusWriter:
    """Atomic JSON writer for a single status file.

    Construct once per training run; call ``update`` at any time to
    publish a new snapshot. ``update`` merges its kwargs with the
    last-published snapshot so a caller doesn't need to re-supply
    immutable fields (started_at_ms, host_pid) on every tick.
    """

    def __init__(self, path: Path) -> None:
        self._path = Path(path)
        self._started_at_ms = int(time.time() * 1000)
        self._host_pid = os.getpid()
        self._snapshot: dict[str, Any] = {
            "state": "starting",
            "started_at_ms": self._started_at_ms,
            "host_pid": self._host_pid,
        }
        # Cleanup hook installed by `install_signal_handlers`; held here
        # so tests can uninstall to avoid leaking global handlers between
        # test cases.
        self._original_sigterm: Optional[Any] = None
        self._original_sigint: Optional[Any] = None

    @property
    def path(self) -> Path:
        return self._path

    def write(self, **fields: Any) -> None:
        """Write a fresh snapshot, merging ``fields`` into the cache.

        Atomic via tmp + ``os.replace``. Best-effort: any IOError is
        swallowed (logged to stderr) so a transient disk hiccup doesn't
        kill an otherwise-healthy training run.
        """
        self._snapshot.update(fields)
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp_path = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp_path.write_text(
                json.dumps(self._snapshot, sort_keys=True, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp_path, self._path)
        except OSError as exc:
            # Don't let a status-write failure abort training. The
            # operator can still recover via the scheduled_jobs row.
            print(
                f"[kartograf-train] status-file write failed: {exc}",
                flush=True,
            )

    def start(self, **fields: Any) -> None:
        """Publish the ``starting`` state with any caller-supplied context."""
        self.write(state="starting", **fields)

    def running(self, **fields: Any) -> None:
        """Publish a ``running`` snapshot — call once per log-cadence tick."""
        self.write(state="running", **fields)

    def completed(self, **fields: Any) -> None:
        """Publish ``completed`` — only after eval + envelope sign."""
        self.write(state="completed", completed_at_ms=int(time.time() * 1000), **fields)

    def failed(self, reason: str, **fields: Any) -> None:
        """Publish ``failed`` with an error reason string."""
        self.write(
            state="failed",
            failed_at_ms=int(time.time() * 1000),
            error=reason,
            **fields,
        )

    def cancelled(self, signal_name: str, **fields: Any) -> None:
        """Publish ``cancelled`` from inside a signal handler."""
        self.write(
            state="cancelled",
            cancelled_at_ms=int(time.time() * 1000),
            signal=signal_name,
            **fields,
        )

    def install_signal_handlers(
        self,
        on_cancel: Optional[Callable[[_HostStateName], None]] = None,
    ) -> None:
        """Install SIGTERM + SIGINT handlers that publish ``cancelled``.

        ``on_cancel`` runs before the cancellation status is written so
        the caller can attempt a best-effort flush (e.g.
        ``torch.save(best_state, ...)``). After the status writes the
        handler re-raises via ``SystemExit(130)`` so the process exits
        with the conventional Ctrl-C code.
        """

        def _handler(signum: int, _frame: Any) -> None:
            try:
                sig_name = signal.Signals(signum).name
            except ValueError:
                sig_name = f"signal-{signum}"
            if on_cancel is not None:
                try:
                    on_cancel(sig_name)
                except Exception as exc:  # pragma: no cover — never propagate
                    print(
                        f"[kartograf-train] on_cancel hook raised {type(exc).__name__}: {exc}",
                        flush=True,
                    )
            self.cancelled(signal_name=sig_name)
            raise SystemExit(130)

        self._original_sigterm = signal.signal(signal.SIGTERM, _handler)
        self._original_sigint = signal.signal(signal.SIGINT, _handler)

    def uninstall_signal_handlers(self) -> None:
        """Restore the handlers that were in place before install."""
        if self._original_sigterm is not None:
            signal.signal(signal.SIGTERM, self._original_sigterm)
            self._original_sigterm = None
        if self._original_sigint is not None:
            signal.signal(signal.SIGINT, self._original_sigint)
            self._original_sigint = None


def make_status_writer(path: Optional[Path]) -> Optional[StatusWriter]:
    """Convenience factory — returns ``None`` when ``path`` is ``None``.

    Lets ``train.run`` accept an optional status-file path and call this
    once at startup without branching the rest of the loop.
    """
    if path is None:
        return None
    return StatusWriter(Path(path))
