# CLI: ask

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
- `runCli(argv: string[]): Promise<void>`

## Example

```bash
memphis-v4 ask --input "hello" --session demo
```
