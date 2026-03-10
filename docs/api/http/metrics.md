# HTTP: metrics

## Signatures
- `createHttpServer(config: object, orchestration: OrchestrationService, repos?: object): FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, AppLogger, FastifyTypeProviderDefault> & PromiseLike<FastifyInstance<Server<typeof IncomingMessage, typeof ServerResponse>, IncomingMessage, ServerResponse<IncomingMessage>, AppLogger, FastifyTypeProviderDefault>> & object`

## Example

```bash
curl -s http://127.0.0.1:8787/v1/ops/status
```
