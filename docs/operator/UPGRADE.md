# Memphis Upgrade Guide

## v1.0.1 to v1.1.0

### What Changed

- **Documentation**: Complete rewrite of README, new User Guide, enhanced Troubleshooting
- **Vault-first secrets**: All provider keys and tokens resolve through vault. Raw `.env` keys still work as fallback but vault is preferred
- **Chain flow hardening**: All 7 chain types now write during normal operation. Previously, decisions/reflections/patterns chains could remain empty
- **TUI enhancements**: Status bar shows cognitive mode, provider status, PULSE health. New session management features
- **Provider clarity**: Ollama fallback status clearly indicated. MiniMax integration path prepared
- **Telegram docs**: Complete BotFather walkthrough and bidirectional command reference
- **Session isolation**: Sessions no longer risk file conflicts during concurrent use
- **Deep cleanup**: Dead code removed, error messages standardized, import cleanup
- **Test fixes**: 5 previously failing tests fixed (error message updates, exec policy alignment)

### Migration Steps

```bash
cd /path/to/memphis
git pull origin main
npm install
npm run build
```

### Breaking Changes

None. All changes are additive or internal. Chain format is unchanged. Vault is backwards compatible.

### New .env Options

No new required options. Existing `.env` files work without modification.

### Verify

```bash
memphis health --json
memphis doctor --json
```

---

## General Upgrade Process

Memphis follows semantic versioning. For any version upgrade:

1. **Pull latest code**: `git pull origin main`
2. **Install dependencies**: `npm install`
3. **Build**: `npm run build`
4. **Check health**: `memphis health --json`
5. **Run doctor**: `memphis doctor --json`

### Data Safety

- Chains are append-only: upgrades never modify existing entries
- SQLite indexes are derived: they can be rebuilt from chains
- Vault encryption is stable: your secrets survive upgrades
- Soul manifest is regenerated on startup: always matches current code

### Rollback

If an upgrade causes issues:

```bash
git log --oneline -5            # Find the previous version tag
git checkout v1.0.1             # Roll back to previous version
npm install
npm run build
memphis health --json
```

Your chain data and vault remain intact across rollbacks.
