import { resolveProviderKeyResult } from './index.js';
import { parseBool } from '../core/env.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';


export interface ProviderKeyConflict {
  provider: string;
  severity: 'warn' | 'error';
  reason:
    | 'vault_ref_and_plaintext_both_set'
    | 'vault_ref_set_but_entry_missing_with_plaintext_fallback'
    | 'vault_decryption_error_with_plaintext_fallback';
  vaultRefEnv: string;
  plaintextEnv: string;
  detail?: string;
}

interface ProviderDescriptor {
  provider: string;
  vaultRefEnv: string;
  plaintextEnv: string;
}

const PROVIDERS: ProviderDescriptor[] = [
  { provider: 'anthropic', vaultRefEnv: 'ANTHROPIC_VAULT_KEY', plaintextEnv: 'ANTHROPIC_API_KEY' },
  { provider: 'minimax', vaultRefEnv: 'MINIMAX_VAULT_KEY', plaintextEnv: 'MINIMAX_API_KEY' },
  { provider: 'deepseek', vaultRefEnv: 'DEEPSEEK_VAULT_KEY', plaintextEnv: 'DEEPSEEK_API_KEY' },
  { provider: 'glm', vaultRefEnv: 'GLM_VAULT_KEY', plaintextEnv: 'GLM_API_KEY' },
];

export function detectProviderKeyConflicts(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ProviderKeyConflict[] {
  const conflicts: ProviderKeyConflict[] = [];

  for (const descriptor of PROVIDERS) {
    const vaultRef = rawEnv[descriptor.vaultRefEnv]?.trim();
    const plaintext = rawEnv[descriptor.plaintextEnv]?.trim();

    if (!vaultRef) continue;

    const plaintextIsActualValue = plaintext && !plaintext.startsWith('VAULT:');
    if (!plaintextIsActualValue) continue;

    const resolution = resolveProviderKeyResult(descriptor.provider, rawEnv);

    if (resolution.source === 'vault') {
      conflicts.push({
        provider: descriptor.provider,
        severity: 'warn',
        reason: 'vault_ref_and_plaintext_both_set',
        vaultRefEnv: descriptor.vaultRefEnv,
        plaintextEnv: descriptor.plaintextEnv,
        detail:
          'Vault entry resolves successfully; plaintext is redundant and a security liability. ' +
          `Remove ${descriptor.plaintextEnv} from .env.`,
      });
    } else if (resolution.source === 'conflict') {
      conflicts.push({
        provider: descriptor.provider,
        severity: 'error',
        reason:
          resolution.vaultError.includes('decrypt') || resolution.vaultError.includes('integrity')
            ? 'vault_decryption_error_with_plaintext_fallback'
            : 'vault_ref_set_but_entry_missing_with_plaintext_fallback',
        vaultRefEnv: descriptor.vaultRefEnv,
        plaintextEnv: descriptor.plaintextEnv,
        detail: resolution.vaultError,
      });
    }
  }

  return conflicts;
}

export interface ConflictDetectionOutcome {
  conflicts: ProviderKeyConflict[];
  strictMode: boolean;
  shouldExit: boolean;
}

export function reportProviderKeyConflicts(
  rawEnv: NodeJS.ProcessEnv = process.env,
  writer: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): ConflictDetectionOutcome {
  const conflicts = detectProviderKeyConflicts(rawEnv);
  const strictMode = parseBool(rawEnv.MEMPHIS_STRICT_MODE);

  for (const conflict of conflicts) {
    writer(
      `[memphis-provider] ${conflict.severity === 'error' ? 'ERROR' : 'WARN'}: ${conflict.provider} ` +
        `key conflict (${conflict.reason}). ${conflict.vaultRefEnv} and ${conflict.plaintextEnv} ` +
        `both set. ${conflict.detail ?? ''}`.trim(),
    );
    writeSecurityAudit(
      {
        action: 'provider.key-conflict',
        status: conflict.severity === 'error' ? 'error' : 'allowed',
        details: {
          provider: conflict.provider,
          reason: conflict.reason,
          vaultRefEnv: conflict.vaultRefEnv,
          plaintextEnv: conflict.plaintextEnv,
          strictMode,
        },
      },
      rawEnv,
    );
  }

  const hasErrorLevel = conflicts.some((c) => c.severity === 'error');
  const shouldExit = strictMode && conflicts.length > 0;

  if (shouldExit) {
    writer(
      '[memphis-provider] MEMPHIS_STRICT_MODE=true and provider key conflicts detected — refusing to boot. ' +
        'Fix .env and restart, or unset MEMPHIS_STRICT_MODE.',
    );
  } else if (hasErrorLevel) {
    writer(
      '[memphis-provider] Error-level conflicts detected; the provider will be skipped at runtime. ' +
        "Run 'memphis doctor' for remediation steps.",
    );
  }

  return { conflicts, strictMode, shouldExit };
}
