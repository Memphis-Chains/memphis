# Memphis — clean install from scratch

Audited install path. Each command is verified against actual source. Each step explains what files it creates so you can spot a half-broken state immediately.

## 0. Wipe existing state (ONLY if you want to start over)

> Reads/writes vault state, chain blocks, soul memory. Backup first if you have anything you want.

```bash
# Stop running daemon if any
systemctl --user stop memphis 2>/dev/null || true

# Remove repo working tree (keeps git config + global links)
rm -rf ~/memphis ~/.memphis

# Remove globally-linked CLI (re-linked by step 1)
npm uninstall -g @memphis-chains/memphis 2>/dev/null || true

# Remove systemd unit (will be re-installed by step 4)
rm -rf ~/.config/systemd/user/memphis.service ~/.config/systemd/user/memphis.service.d
systemctl --user daemon-reload
```

## 1. Install the runtime

The installer clones the repo to `~/memphis`, builds Rust + TS, links the `memphis` CLI globally. Defaults to interactive prompts; pre-set `MEMPHIS_YES=1` for unattended.

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash -s -- --with-init
```

What it touches:
- Apt/brew packages: `git`, `curl`, `build-essential`, `pkg-config`, `libssl-dev` (Linux)
- Node 22 via NodeSource (Linux) or Homebrew (macOS) — only if missing
- Rust stable via rustup — only if missing
- Clones to `~/memphis/`
- Runs `npm install` + `npm run build` (Rust workspace + TS compile)
- Runs `npm link` so `memphis` is on PATH globally
- `--with-init` flag (recommended) chains `memphis init` so the session ends with a vault, identity, and first chains — not just a CLI on PATH

If `--with-init` was off, run init manually next:
```bash
cd ~/memphis
memphis init
```

What `memphis init` creates:
- `~/memphis/.env` — operator config (passphrase salts, default provider, etc.)
- `~/.memphis/vault-state.json` — encrypted master key (Argon2id-derived, AES-256-GCM-wrapped)
- `~/.memphis/vault-entries.json` — encrypted secret store (initially empty)
- `~/.memphis/chains/` — append-only journal/decisions/reflections/system/cases/etc. (10 chains)
- `~/.memphis/config/soul-manifest.json` — agent identity (name, owner, autonomy mode)
- `~/.memphis/PULSE.md` — health heartbeat history
- `~/.memphis/memphis.db` — SQLite indexes derived from chains

## 2. Verify the install

```bash
memphis doctor
```

Should print PASS for: chains, vault, runtime config, providers, embeddings. Any FAIL is a real problem — paste the output if you need help.

## 3. (Optional) Add LLM provider credentials

Memphis runs offline by default via local-fallback (no real LLM, but doesn't hang). Add a provider to get real intelligence:

```bash
# Choose ONE or more — providers cascade in order
memphis vault add --key anthropic_api_key   # claude-sonnet-4-6, ctx:200k
memphis vault add --key minimax_api_key     # MiniMax-M2.7, ctx:32k
memphis vault add --key deepseek_api_key    # deepseek-chat, ctx:64k
memphis vault add --key glm_api_key         # glm-4-flash, ctx:32k
```

Each command prompts for operator passphrase (set in step 1) and the API key. Memphis encrypts the key under the vault master key.

Optional Ollama (truly local, no API key needed — needs `ollama serve` running):
```bash
ollama serve &
ollama pull cogito:3b   # or any model you want as default
echo 'OLLAMA_MODEL=cogito:3b' >> ~/memphis/.env
```

`OLLAMA_KEEP_ALIVE` defaults to `24h` so the model stays warm; override only if you specifically want stock 5-min unload.

## 4. (Optional) Install systemd service for autostart

Linux only. macOS users skip this; run `memphis tui` directly when you need it.

```bash
memphis service install
memphis service restart
memphis service status   # confirm "active (running)"
```

What this does: writes `~/.config/systemd/user/memphis.service` pointing at the linked binary, runs it as `npm run dev` style. The service comes back on reboot via systemd-user.

> **Known gap (refactor #4 in the plan)**: if you set `MEMPHIS_DATA_DIR` to a non-default location in your `.bashrc`, the systemd unit won't inherit it. Workaround for now: write a drop-in:
> ```bash
> mkdir -p ~/.config/systemd/user/memphis.service.d
> cat > ~/.config/systemd/user/memphis.service.d/env.conf <<EOF
> [Service]
> Environment=MEMPHIS_DATA_DIR=$MEMPHIS_DATA_DIR
> EOF
> systemctl --user daemon-reload
> systemctl --user restart memphis
> ```

## 5. Open the cockpit

```bash
memphis tui
```

You should see:
- Inventory: chains, blocks, vault entries, sessions
- Provider status (one ● green per configured provider)
- Cognitive mode bar at the bottom

Type `yo` and hit Enter — should get a real LLM response within a few seconds (Anthropic/MiniMax) or 1-3s (Ollama if model is warm) or instant `[local-fallback]` notice (no real provider).

## 6. Optional channels

```bash
# Telegram bot (interactive setup)
memphis setup telegram --bot-token <token>
memphis service restart

# Matrix (interactive setup)
memphis setup matrix --server-name <name> --admin-user <user> --admin-pass <pass>
```

## Common failure modes (what to check first)

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| TUI shows "vault uninitialized" but `memphis vault list` works | Vault path split (TS vs Rust defaults disagree) | Run `memphis tui` from `~/memphis` cwd, not from `~`. Refactor #1 in the plan eliminates this class. |
| Bot says "missing api key — vault entry could not be read" but `vault list` shows the entry | Same path split, runtime can't decrypt | After PR #350 + #351 + #355 you get a one-line `[memphis-vault] using legacy ~/.memphis/vault-state.json` notice — that means auto-resolve worked. If you see "vault path split: ... no fallback found" — copy `~/.memphis/vault-state.json` to wherever entries live. |
| `memphis tui` hangs on first message | Ollama model cold-load on a slow CPU | Stays warm by default after first request (24h). If first request itself times out: `ollama run cogito:3b "" </dev/null` to pre-warm. |
| `memphis service install` succeeds but `memphis service status` says inactive | systemd-user not running, or `XDG_RUNTIME_DIR` unset | `loginctl enable-linger $USER`, re-login. |
| `memphis init` writes `.env` to wrong place | Ran from non-repo cwd; install root walk fails | `cd ~/memphis` before `memphis init`. Refactor #4 fixes the cwd-walk. |
| Bot says "która godzina" with different answers each turn | Old build without `<runtime_clock>` injection | `cd ~/memphis && git pull && npm run build`. PR #349 added the clock. |

## Verification checklist

Run these in order; each should succeed:

```bash
memphis doctor                                        # all PASS
memphis vault list                                    # entries you added in step 3
memphis providers list                                # configured providers ●
memphis chain verify                                  # chain integrity OK
memphis health                                        # PULSE healthy
node bin/memphis.js chat --input "ping" --json        # actual LLM response
```

If any of these fail with no clear error, paste the output — the audit plan + memory files have the diagnostic context to debug fast.
