#!/usr/bin/python3
"""Git shim used only by the isolated process-kill integration test."""
import os
import signal
import subprocess
import sys

if len(sys.argv) > 1 and sys.argv[1] == 'merge':
    directory = os.path.dirname(os.path.realpath(__file__))
    with open(os.path.join(directory, 'phase'), encoding='utf8') as source:
        phase = source.read()
    with open(os.path.join(directory, 'marker-path'), encoding='utf8') as source:
        marker_path = source.read()
    if phase == 'after':
        result = subprocess.run(['/usr/bin/git', *sys.argv[1:]])
        if result.returncode:
            sys.exit(result.returncode)
    os.kill(os.getppid(), signal.SIGSTOP)
    with open(marker_path, 'w', encoding='utf8') as marker:
        marker.write(phase)
    os.kill(os.getpid(), signal.SIGSTOP)
    sys.exit(1)
os.execv('/usr/bin/git', ['/usr/bin/git', *sys.argv[1:]])
