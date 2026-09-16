#!/usr/bin/env bash
# Terminal-friendly launcher for the desktop entry default action.
exec /home/memphis/.local/bin/memphis-camera-stream-matrix 2>&1 | tee /tmp/memphis-stream.log