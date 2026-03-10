# CLI: vault

## Signatures
- `getRustVaultAdapterStatus(rawEnv: ProcessEnv): RustVaultAdapterStatus`
- `vaultDecrypt(entry: VaultEntry, rawEnv: ProcessEnv): string`
- `vaultEncrypt(key: string, plaintext: string, rawEnv: ProcessEnv): VaultEntry`
- `vaultInit(input: VaultInitInput, rawEnv: ProcessEnv): object`
- `runCli(argv: string[]): Promise<void>`

## Example

```bash
memphis-v4 vault add --key token --value secret
```
