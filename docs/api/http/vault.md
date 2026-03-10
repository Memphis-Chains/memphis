# HTTP: vault

## Signatures
- `createHttpServer(config: object, orchestration: OrchestrationService, repos?: object): FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, AppLogger, FastifyTypeProviderDefault> & PromiseLike<FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, AppLogger, FastifyTypeProviderDefault>> & object`
- `getRustVaultAdapterStatus(rawEnv: ProcessEnv): RustVaultAdapterStatus`
- `vaultDecrypt(entry: VaultEntry, rawEnv: ProcessEnv): string`
- `vaultEncrypt(key: string, plaintext: string, rawEnv: ProcessEnv): VaultEntry`
- `vaultInit(input: VaultInitInput, rawEnv: ProcessEnv): object`

## Example

```bash
curl -s http://127.0.0.1:8787/v1/ops/status
```
