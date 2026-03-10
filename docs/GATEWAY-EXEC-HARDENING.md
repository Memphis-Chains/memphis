# Gateway `/exec` hardening (H4.4)

## Goal
Reduce remote execution attack surface for gateway `/exec`.

## Policy
When `GATEWAY_EXEC_RESTRICTED_MODE=true`, `/exec` enforces:
1. Command must start with allowlisted base binary (`GATEWAY_EXEC_ALLOWLIST`).
2. Command cannot contain blocked shell tokens (`GATEWAY_EXEC_BLOCKED_TOKENS`).

Default safe allowlist:
- `echo,pwd,ls,whoami,date,uptime`

Default blocked tokens:
- `&&,||,;,|,>,<,$(,```

## Environment variables
```env
GATEWAY_EXEC_RESTRICTED_MODE=true
GATEWAY_EXEC_ALLOWLIST=echo,pwd,ls,whoami,date,uptime
GATEWAY_EXEC_BLOCKED_TOKENS=&&,||,;,|,>,<,$(,`
```

## Smoke
```bash
npm run -s test:smoke:phase4-gateway-exec-hardening
```

## Regression expectations
- `/exec` returns `403 FORBIDDEN` for non-allowlisted commands in restricted mode.
- `/exec` returns `403 FORBIDDEN` for blocked token usage in restricted mode.
- Legacy compatibility can be restored with `GATEWAY_EXEC_RESTRICTED_MODE=false`.
