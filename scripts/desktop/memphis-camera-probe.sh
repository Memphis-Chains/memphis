#!/usr/bin/env bash
v4l2-ctl --list-devices
echo "---"
v4l2-ctl -d /dev/video1 --all | head -20