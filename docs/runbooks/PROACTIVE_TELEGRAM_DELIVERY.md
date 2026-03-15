# Proactive Telegram Delivery Runbook

Use this runbook to enable and validate Telegram delivery for proactive assistant messages.

## 1. Opt-In Controls

Telegram delivery is disabled by default. It only activates when all required settings are present.

Required environment variables:

- `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED=true`
- `MEMPHIS_PROACTIVE_TELEGRAM_BOT_TOKEN=<bot-token>`
- `MEMPHIS_PROACTIVE_TELEGRAM_CHAT_ID=<chat-id>`

Optional legacy aliases (supported as fallback for credentials):

- `MEMPHIS_TELEGRAM_BOT_TOKEN`
- `MEMPHIS_TELEGRAM_CHAT_ID`

## 2. Safety Behavior

- If `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED` is not `true`, delivery is skipped.
- If token/chat ID is missing, delivery is skipped.
- If transport errors occur, delivery failures are logged and message generation continues.
- Proposal/insight persistence behavior is unaffected by Telegram transport outcomes.

## 3. Validation Steps

1. Set required env vars in a non-production environment.
2. Trigger proactive checks through the assistant flow.
3. Verify messages arrive in Telegram chat.
4. Confirm process logs include delivery counts and no fatal errors.

## 4. Failure Triage

Symptoms and actions:

- No messages and no delivery logs:
  - confirm `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED=true`
- Delivery attempted but failed:
  - validate bot token and chat ID
  - verify bot is allowed to post in target chat
  - check network egress from runtime host to `api.telegram.org`
- Intermittent failures:
  - review process logs for response status codes
  - monitor retry policy at the orchestration layer (if configured)

## 5. Rollback

Disable immediately by setting:

- `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED=false`

No data migrations are required for rollback.

## 6. Credential Rotation

For production token/chat credential rotation without delivery downtime, follow:

- `docs/runbooks/TELEGRAM_CREDENTIAL_ROTATION.md`
