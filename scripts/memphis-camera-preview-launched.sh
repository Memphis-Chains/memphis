#!/usr/bin/env bash
# Always-on camera preview launcher.
# Używany przez systemd user service i ad-hoc.
export DISPLAY=:0.0
export XAUTHORITY=/home/memphis/.Xauthority
export GDK_BACKEND=x11
exec gst-launch-1.0 -e \
  v4l2src device=/dev/video1 do-timestamp=true \
  ! image/jpeg,width=1280,height=720,framerate=30/1 \
  ! jpegdec \
  ! videoconvert \
  ! videoscale ! video/x-raw,width=640,height=360 \
  ! ximagesink force-aspect-ratio=true display=:0.0