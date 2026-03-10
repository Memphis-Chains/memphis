# CLI: providers

## Signatures
- `listConfiguredProviders(env: ProcessEnv): ProviderListItem[]`
- `listModelsWithCapabilities(env: ProcessEnv): Promise<ModelListItem[]>`
- `runCli(argv: string[]): Promise<void>`

## Example

```bash
memphis-v4 providers list
```
