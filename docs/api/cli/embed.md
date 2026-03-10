# CLI: embed

## Signatures
- `embedReset(rawEnv: ProcessEnv): object`
- `embedSearch(query: string, topK: number, rawEnv: ProcessEnv): object`
- `embedSearchTuned(query: string, topK: number, rawEnv: ProcessEnv): object`
- `embedStore(id: string, text: string, rawEnv: ProcessEnv): object`
- `getRustEmbedAdapterStatus(rawEnv: ProcessEnv): RustEmbedAdapterStatus`
- `runCli(argv: string[]): Promise<void>`

## Example

```bash
memphis-v4 embed search --query "onboarding" --top-k 5
```
