# CLI: onboarding

## Signatures
- `buildHostBootstrapPlan(profile: WizardProfile, outPath: string, force: boolean): HostBootstrapPlan`
- `checklistFromEnv(rawEnv: ProcessEnv): object[]`
- `generateEnvProfile(profile: WizardProfile): string`
- `runHostBootstrapPlan(plan: HostBootstrapPlan, apply: boolean): HostBootstrapExecution`
- `runWizardInteractive(defaultProfile: WizardProfile): Promise<object>`
- `writeProfileEnv(profile: WizardProfile, outPath: string, force: boolean): object`
- `runCli(argv: string[]): Promise<void>`

## Example

```bash
memphis-v4 onboarding wizard --interactive --write --out .env
```
