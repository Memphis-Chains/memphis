# Core API: vault

## Signatures
- `getRustVaultAdapterStatus(rawEnv: ProcessEnv): RustVaultAdapterStatus`
- `vaultDecrypt(entry: VaultEntry, rawEnv: ProcessEnv): string`
- `vaultEncrypt(key: string, plaintext: string, rawEnv: ProcessEnv): VaultEntry`
- `vaultInit(input: VaultInitInput, rawEnv: ProcessEnv): object`

## Examples

```ts
// import from runtime modules and call with validated input
```
