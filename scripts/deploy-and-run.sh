#!/bin/bash
# Memphis Auto-Deploy and Run
# Wykonywany codziennie o 20:00 przez systemd timer

MEMPHIS_DIR="/home/memphis/memphis"
LOG_FILE="$MEMPHIS_DIR/logs/cron-deploy.log"
HOOKS_DIR="$MEMPHIS_DIR/scripts/cron-hooks"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Rozpoczynam deploy-and-run ==="

cd "$MEMPHIS_DIR" || exit 1

# 1. Sprawdź zmiany w git
if git status --porcelain | grep -q .; then
    log "Znaleziono zmiany w git - deployuję..."
    
    # Pull latest
    git pull origin main 2>&1 | tee -a "$LOG_FILE"
    
    # Rebuild
    npm run build 2>&1 | tee -a "$LOG_FILE"
    
    # Restart Memphis jeśli działa
    if systemctl --user is-active --quiet memphis.service; then
        log "Restartuję Memphis..."
        systemctl --user restart memphis.service
        sleep 3
        log "Memphis zrestartowany"
    fi
else
    log "Brak zmian w git, pomijam deploy"
fi

# 2. Wykonaj hooki
if [ -d "$HOOKS_DIR" ]; then
    log "Wykonuję hooki z $HOOKS_DIR/"
    for hook in "$HOOKS_DIR"/*.py "$HOOKS_DIR"/*.sh; do
        [ -f "$hook" ] || continue
        log "Uruchamiam: $(basename "$hook")"
        bash "$hook" 2>&1 | tee -a "$LOG_FILE" || log "Hook $(basename "$hook") zakończył się błędem"
    done
fi

log "=== Zakończono deploy-and-run ==="
