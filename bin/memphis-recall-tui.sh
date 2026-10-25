#!/usr/bin/env bash
# Prompt for a query, then show exact-phrase matches from the chains.
set -uo pipefail
cd "$HOME/memphis" || exit 1
printf 'Szukaj w pamięci Memphis: '
read -r q
[ -z "$q" ] && exit 0
printf '\n'
exec node bin/memphis.js search --query "$q" --top-k 8
