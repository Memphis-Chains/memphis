#!/usr/bin/env bash
# Zatrzymuje preview okno (idempotentny).
exec pkill -f "vlc.*memphis-camera-preview\|vlc.*v4l2:///dev/video\|gst-launch.*v4l2src" 2>&1
echo "preview zatrzymany"