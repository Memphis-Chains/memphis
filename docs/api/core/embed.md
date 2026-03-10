# Core API: embed

## Signatures
- `embedReset(rawEnv: ProcessEnv): object`
- `embedSearch(query: string, topK: number, rawEnv: ProcessEnv): object`
- `embedSearchTuned(query: string, topK: number, rawEnv: ProcessEnv): object`
- `embedStore(id: string, text: string, rawEnv: ProcessEnv): object`
- `getRustEmbedAdapterStatus(rawEnv: ProcessEnv): RustEmbedAdapterStatus`

## Examples

```ts
// import from runtime modules and call with validated input
```
