# Telegram Credential Rotation Runbook

Use this runbook to rotate proactive Telegram bot credentials with no delivery downtime.

## 1. Scope

This applies to proactive assistant delivery configured through:

- `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED=true`
- `MEMPHIS_PROACTIVE_TELEGRAM_BOT_TOKEN`
- `MEMPHIS_PROACTIVE_TELEGRAM_CHAT_ID`

## 2. Preconditions

1. You can deploy MemphisOS with rolling updates (one instance at a time).
2. You can keep the old token active until all instances are updated.
3. The new bot is already added to the destination Telegram chat.
4. You have log visibility for delivery success/failure counters.

## 3. Zero-Downtime Rotation Procedure

1. Create a new bot token with BotFather (do not revoke old token yet).
2. Verify the new bot can post to the target chat manually.
3. Store new token/chat ID in your secret manager as next values.
4. Start a rolling deployment that updates one MemphisOS instance at a time.
5. For each updated instance, confirm logs show successful Telegram delivery.
6. Continue rollout until all instances run with the new credentials.
7. Monitor delivery for one full reflection/proactive cycle window.
8. Revoke the old token only after the new token is confirmed stable cluster-wide.

## 4. Validation Checklist

- `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED` remains `true` during the rollout.
- No sustained increase in transport failures in application logs.
- Telegram chat receives proactive messages before, during, and after rollout.
- No blocking impact on proposal/insight generation paths.

## 5. Rollback

If new credentials fail:

1. Redeploy previous secret version (old token/chat ID).
2. Repeat rolling update back to last known-good credentials.
3. Keep old token active until delivery is stable again.
4. Re-run validation checklist.

## 6. Failure Notes

- If both old and new tokens fail, disable Telegram delivery immediately:
  - `MEMPHIS_PROACTIVE_TELEGRAM_ENABLED=false`
- Delivery disablement is fail-safe and does not block core orchestration paths.
