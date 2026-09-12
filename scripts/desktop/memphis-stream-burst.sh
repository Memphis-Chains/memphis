#!/usr/bin/env bash
exec /home/memphis/.local/bin/memphis-camera-stream-matrix /dev/video1 1280 720 15 5 thumbnail \
  2>&1 | tee /tmp/memphis-stream-burst.log