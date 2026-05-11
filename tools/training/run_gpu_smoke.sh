#!/usr/bin/env bash
# Runner for GPU smoke test — activates venv + runs benchmark.
# Usage: bash tools/training/run_gpu_smoke.sh > smoke-output.txt 2>&1
set -e

VENV=$HOME/.venvs/memphis-train
if [ ! -x "$VENV/bin/python" ]; then
    echo "ERR: venv missing at $VENV. Run: uv venv --python 3.11 $VENV" >&2
    exit 1
fi

source "$VENV/bin/activate"
echo "Python: $(python --version)"
echo "Torch: $(python -c 'import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available())')"
echo

python /home/memphis/memphis/tools/training/gpu_smoke_test.py
