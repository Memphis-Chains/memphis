# CLI: chain

## Signatures
- `formatImportReport(result: ImportJsonResult, writeResult?: ImportWriteResult): string`
- `guardWriteMode(options: object): void`
- `runImportJsonFromFile(file: string): ImportJsonResult`
- `runImportJsonPayload(payload: unknown): ImportJsonResult`
- `transactionalWriteBlocks(targetPath: string, blocks: NormalizedChainBlock[]): object`
- `getChainAdapterStatus(rawEnv: ProcessEnv): ChainAdapterStatus`

## Example

```bash
memphis-v4 chain import_json --file ./blocks.json --write --confirm-write
```
