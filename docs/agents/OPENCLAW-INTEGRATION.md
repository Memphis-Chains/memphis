# OpenClaw Integration — DEPRECATED

> **OpenClaw has been deprecated.** MemphisOS now has a built-in Telegram/Discord gateway. Use that instead.

## Built-in Channel Gateway

MemphisOS runs Telegram and Discord adapters directly — no separate process needed.

```bash
# Enable Telegram gateway
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=<your token>

npm run dev
```

See [QUICK-START-SCENARIOS.md](./QUICK-START-SCENARIOS.md) for the full channel setup guide.
