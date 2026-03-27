# Memphis Git Status — 2026-03-27 (updated 13:02 UTC)

## Stan brancha
- Branch: `main`
- ✅ Na origin/main: 5 nowych commitów od rana:
  - `69bbde3 chore(post-ga): roll forward v1.0.1 baseline`
  - `cabccf5 fix(release): honor configured env file in bootstrap`
  - `6108c64 fix(release): force local embed mode in rc drill`
  - `392be43 chore(release): v1.0.0`
  - `72fd90b fix(release): build package artifact in validator test`
- ✅ Branch jest na bieżąco z origin/main (brak local ahead/behind)

## ⚠️ UNSTAGED CHANGES (47 plików, ~5.5k+/900- linii)
**NIE COMMITOWAĆ — Iskra pracuje**

### Rust/TUI:
- `crates/memphis-tui/src/app.rs` (duży, ~3.5k linii diff)
- `crates/memphis-tui/src/client.rs`
- `crates/memphis-tui/src/ui.rs`, `main.rs`
- `crates/memphis-operator/src/chat.rs`, `provider.rs`, `runtime.rs`
- `crates/memphis-embed/src/pipeline.rs`, `store.rs`
- `crates/memphis-case-index/src/lib.rs`
- `crates/memphis-core/src/case_entry.rs`, `loop_engine.rs`
- `crates/memphis-vault/src/*.rs` (crypto, keyring, vault, two_factor, types)
- `crates/memphis-napi/src/lib.rs`, `vault_bridge.rs`
- `Cargo.lock`

### Docs/Scripts/Config:
- `docs/TUI-OPERATOR-GUIDE.md`, `RE-INSTALL.md`, `POST-INSTALLATION.md`, etc.
- `scripts/rc-drill.sh`, `scripts/validate-package-artifact.mts`
- `bin/memphis.js`, `README.md`
- `memory/sprint-progress.md`
- `openclaw-plugin/package.json`, `src/infra/cli/**/*.ts`
- Test files

### Untracked:
- `PROFILES-MARKETING.md`, `data/`, `openclaw-plugin/README.md`, `src/gateway/channels/telegram-send.ts`, `src/infra/tui-host/`
- Various test files

---
_Zapisano: 2026-03-27 13:02 UTC — cron_
