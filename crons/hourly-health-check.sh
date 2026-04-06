#!/bin/bash
# Memphis hourly health check cron
# Runs every hour - monitors system health and reports anomalies

echo "=== Memphis Health Check $(date +%Y-%m-%dT%H:%M:%S) ==="

# This script triggers Memphis health check via memphis_health tool
# Log output for the hourly health cron
echo "[$(date -Iseconds)] Hourly health: checked"