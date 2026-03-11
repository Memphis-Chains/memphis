#!/bin/bash
# Memphis v5 wrapper script
# Usage: ./memphis-wrapper.sh [command]

export DEFAULT_PROVIDER=local-fallback
export LOCAL_FALLBACK_ENABLED=true
export OLLAMA_BASE_URL=http://localhost:11434

# Run memphis command
memphis "$@"
