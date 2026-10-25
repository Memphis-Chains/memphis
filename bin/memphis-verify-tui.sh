#!/usr/bin/env bash
set -uo pipefail
cd "$HOME/memphis" || exit 1
exec node bin/memphis.js chain verify
