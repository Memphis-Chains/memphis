# Core API: ask

## Signatures
- `appendAskSessionTurn(name: string, turn: AskSessionTurn, env: ProcessEnv): string`
- `askSessionContextTurns(env: ProcessEnv): number`
- `askSessionContextWindowTokens(env: ProcessEnv): number`
- `askSessionPath(name: string, env: ProcessEnv): string`
- `askSessionsDir(env: ProcessEnv): string`
- `askSessionStats(turns: AskSessionTurn[], env: ProcessEnv): object`
- `buildAskSessionPrompt(contextTurns: AskSessionTurn[], currentInput: string): string`
- `clearAskSession(name: string, env: ProcessEnv): string`
- `estimateTokens(content: string): number`
- `readAskSession(name: string, env: ProcessEnv): AskSessionTurn[]`
- `selectContextTurns(turns: AskSessionTurn[], maxTurns: number, maxTokens: number): AskSessionTurn[]`

## Examples

```ts
// import from runtime modules and call with validated input
```
