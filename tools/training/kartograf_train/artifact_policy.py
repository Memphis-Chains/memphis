"""Deployment artifact policy, independent of the optional ML stack."""
from pathlib import Path
from typing import Callable

PLACEHOLDER_ONNX = b"KARTOGRAF_STUB_ONNX_v1\nsee docs/dev/KARTOGRAF-SPEC.md"


def export_training_artifact(mode: str, exporter: Callable[[], bytes], saved_state: Path) -> bytes:
    """Smoke remains an explicit fixture; full training must export real bytes."""
    if mode == "smoke":
        return PLACEHOLDER_ONNX
    if mode != "full":
        raise ValueError("Unknown training export mode")
    try:
        artifact = exporter()
    except Exception as exc:
        raise RuntimeError(
            f"ONNX export failed ({type(exc).__name__}); no deployable checkpoint "
            f"was produced. Trained state retained at {saved_state}; retry export."
        ) from None
    if not isinstance(artifact, bytes) or not artifact or artifact.startswith(b"KARTOGRAF_STUB_ONNX"):
        raise RuntimeError("Full training requires a non-placeholder ONNX artifact")
    return artifact
