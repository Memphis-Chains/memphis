#!/bin/bash
set -e

EVIDENCE_DIR="evidence-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$EVIDENCE_DIR"

echo "Capturing evidence to $EVIDENCE_DIR..."

# System info
echo "=== System Info ===" > "$EVIDENCE_DIR/system.txt"
echo "OS: $(uname -a)" >> "$EVIDENCE_DIR/system.txt"
echo "Node: $(node --version)" >> "$EVIDENCE_DIR/system.txt"
echo "Rust: $(rustc --version)" >> "$EVIDENCE_DIR/system.txt"
echo "Date: $(date -Iseconds)" >> "$EVIDENCE_DIR/system.txt"

# Doctor output
echo "=== Doctor Check ===" > "$EVIDENCE_DIR/doctor.txt"
memphis doctor >> "$EVIDENCE_DIR/doctor.txt" 2>&1 || echo "Doctor failed" >> "$EVIDENCE_DIR/doctor.txt"

# Chain integrity
echo "=== Chain Integrity ===" > "$EVIDENCE_DIR/chain.txt"
memphis verify >> "$EVIDENCE_DIR/chain.txt" 2>&1 || echo "Verify failed" >> "$EVIDENCE_DIR/chain.txt"

# Provider test (if configured)
if memphis provider list | grep -q "openai-compatible"; then
  echo "=== Provider Test ===" > "$EVIDENCE_DIR/provider.txt"
  memphis provider test openai-compatible >> "$EVIDENCE_DIR/provider.txt" 2>&1
fi

# Vault status
echo "=== Vault Status ===" > "$EVIDENCE_DIR/vault.txt"
memphis vault status >> "$EVIDENCE_DIR/vault.txt" 2>&1 || echo "Vault not initialized" >> "$EVIDENCE_DIR/vault.txt"

# Decision count
echo "=== Decision Count ===" > "$EVIDENCE_DIR/decisions.txt"
memphis decisions list | wc -l >> "$EVIDENCE_DIR/decisions.txt"

# Create summary
cat > "$EVIDENCE_DIR/SUMMARY.md" <<EOF
# Memphis v4 Evidence Snapshot

**Captured:** $(date -Iseconds)
**Host:** $(hostname)

## Files

- system.txt - System information
- doctor.txt - Doctor diagnostics
- chain.txt - Chain integrity verification
- provider.txt - Provider health (if configured)
- vault.txt - Vault status
- decisions.txt - Decision count

## Quick Summary

\`\`\`
$(cat "$EVIDENCE_DIR/doctor.txt")
\`\`\`

## Next Steps

1. Review all evidence files
2. Attach screenshots if needed
3. Fill evidence template
4. Submit for audit
EOF

echo "✅ Evidence captured in $EVIDENCE_DIR/"
echo "Review files and fill evidence template"
