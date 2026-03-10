# Core API: errors

## Signatures
- `AppError(code: ErrorCode, message: string, statusCode: number, details?: Record<string, unknown>): AppError`
- `toAppError(error: unknown): AppError`

## Examples

```ts
// import from runtime modules and call with validated input
```

## Error Codes
- `VALIDATION_ERROR`
- `PROVIDER_UNAVAILABLE`
- `PROVIDER_TIMEOUT`
- `PROVIDER_RATE_LIMIT`
- `CONFIG_ERROR`
- `INTERNAL_ERROR`
