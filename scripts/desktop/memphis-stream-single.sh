#!/usr/bin/env bash
# Wrappers used by memphis-camera-matrix.desktop (XFCE wymaga Exec bez metacharów).
# Każdy wrapper = jeden Exec bez pipe/redirect.
exec /home/memphis/.local/bin/memphis-camera-stream-matrix /dev/video1 1280 720 15 5 single \
  2>&1 | tee /tmp/memphis-stream-single.log