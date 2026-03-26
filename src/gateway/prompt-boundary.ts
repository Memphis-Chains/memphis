import { createHash } from 'node:crypto';

import { emitRuntimeSecurityEvent } from '../security/runtime-security-events.js';

export type InputRiskLevel = 'low' | 'medium' | 'high';

export type InputRiskClassification = {
  risk: InputRiskLevel;
  flags: string[];
  contentHash: string;
};

type RiskPattern = {
  flag: string;
  re: RegExp;
  risk: InputRiskLevel;
};

const INPUT_PATTERNS: RiskPattern[] = [
  { flag: 'instruction_override', re: /ignore|forget|disregard/iu, risk: 'high' },
  { flag: 'role_hijack', re: /pretend|act as|you are now/iu, risk: 'high' },
  {
    flag: 'secret_fishing',
    re: /reveal|show|print|dump.+(?:secret|token|password|prompt)/iu,
    risk: 'high',
  },
  {
    flag: 'prompt_exfiltration',
    re: /system prompt|hidden instructions|developer message/iu,
    risk: 'high',
  },
  { flag: 'tool_manipulation', re: /call the tool|use memphis_|invoke tool/iu, risk: 'medium' },
  {
    flag: 'command_injection',
    re: /\bcurl\b|\bwget\b|\brm\s+-rf\b|\bchmod\s+777\b/iu,
    risk: 'medium',
  },
];

const OUTPUT_PATTERNS = [
  {
    flag: 'system_prompt_leak',
    re: /<memphis_system>[\s\S]*<\/memphis_system>/iu,
    replacement: '[filtered: protected system prompt]',
  },
  {
    flag: 'api_token_leak',
    re: /MEMPHIS_API_TOKEN[^\n]*/giu,
    replacement: '[filtered: protected api token reference]',
  },
  {
    flag: 'vault_pepper_leak',
    re: /MEMPHIS_VAULT_PEPPER[^\n]*/giu,
    replacement: '[filtered: protected vault secret reference]',
  },
  {
    flag: 'passphrase_hash_leak',
    re: /passphraseHash[^\n]*/giu,
    replacement: '[filtered: protected passphrase reference]',
  },
  {
    flag: 'vault_plaintext_json_leak',
    re: /"plaintext"\s*:\s*"[^"]*"/giu,
    replacement: '"plaintext":"[filtered: protected vault secret]"',
  },
  {
    flag: 'vault_plaintext_line_leak',
    re: /\bplaintext\s*[:=]\s*[^\n]+/giu,
    replacement: 'plaintext=[filtered: protected vault secret]',
  },
  {
    flag: 'vault_command_output_leak',
    re: /vault get:\s*key=[^\n]+?\s+value=[^\n]+/giu,
    replacement: 'vault get: [filtered: protected vault secret]',
  },
];

function escapeBoundaryText(value: string): string {
  return value.replace(/<\/(user_input|risk_annotation|fetched_content)>/giu, '<\\/$1>');
}

export function classifyUserInput(input: string): InputRiskClassification {
  const flags = new Set<string>();
  let risk: InputRiskLevel = 'low';

  for (const pattern of INPUT_PATTERNS) {
    if (!pattern.re.test(input)) continue;
    flags.add(pattern.flag);
    if (pattern.risk === 'high') risk = 'high';
    else if (risk === 'low') risk = 'medium';
  }

  const contentHash = createHash('sha256').update(input).digest('hex');
  return {
    risk,
    flags: Array.from(flags),
    contentHash,
  };
}

export function buildWrappedUserInput(
  input: string,
  classification: InputRiskClassification,
): string {
  const wrapped = [`<user_input>`, escapeBoundaryText(input), `</user_input>`];
  if (classification.risk !== 'low') {
    wrapped.push(
      `<risk_annotation level="${classification.risk}">flags=${classification.flags.join(', ')}</risk_annotation>`,
    );
  }
  return wrapped.join('\n');
}

export async function auditInputClassification(
  classification: InputRiskClassification,
  surface: string,
): Promise<void> {
  if (classification.risk === 'low') return;
  await emitRuntimeSecurityEvent({
    action: 'prompt.input.flagged',
    status: 'allowed',
    details: {
      surface,
      risk: classification.risk,
      flags: classification.flags,
      contentHash: classification.contentHash,
    },
  });
}

export async function guardModelOutput(
  output: string,
  surface: string,
): Promise<{ output: string; redacted: boolean; flags: string[] }> {
  let redacted = false;
  let next = output;
  const flags: string[] = [];

  for (const pattern of OUTPUT_PATTERNS) {
    if (!pattern.re.test(next)) continue;
    redacted = true;
    flags.push(pattern.flag);
    next = next.replace(pattern.re, pattern.replacement);
  }

  if (redacted) {
    await emitRuntimeSecurityEvent({
      action: 'prompt.output.redacted',
      status: 'blocked',
      details: {
        surface,
        flags,
        contentHash: createHash('sha256').update(output).digest('hex'),
      },
    });
  }

  return { output: next, redacted, flags };
}
