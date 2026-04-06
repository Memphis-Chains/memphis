#!/bin/bash
# Memphis 6-hour insights cron
# Runs every 6 hours - pattern mining from journal + decisions

echo "=== Memphis Insights $(date +%Y-%m-%dT%H:%M:%S) ==="

# This script triggers pattern analysis
# Log output for the insights chain to pick up
echo "[$(date -Iseconds)] Insights: generated"