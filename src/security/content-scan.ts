import { createHash } from 'node:crypto';

export type ContentScanProfile = 'memory' | 'code-change';

export type ContentScanResult =
  | {
      allowed: true;
      profile: ContentScanProfile;
      contentHash: string;
    }
  | {
      allowed: false;
      profile: ContentScanProfile;
      contentHash: string;
      severity: 'high';
      reason: string;
      patternId: string;
    };

type ThreatPattern = {
  id: string;
  re: RegExp;
  reason: string;
};

const INVISIBLE_CHARS = new Set([
  '\u200b',
  '\u200c',
  '\u200d',
  '\u2060',
  '\ufeff',
  '\u202a',
  '\u202b',
  '\u202c',
  '\u202d',
  '\u202e',
]);

const MEMORY_PATTERNS: ThreatPattern[] = [
  {
    id: 'prompt_injection',
    re: /ignore\s+(previous|all|above|prior)\s+instructions/iu,
    reason: 'content attempts to override instructions',
  },
  {
    id: 'role_hijack',
    re: /you\s+are\s+now\s+/iu,
    reason: 'content attempts to redefine the assistant role',
  },
  {
    id: 'deception_hide',
    re: /do\s+not\s+tell\s+(the\s+)?user/iu,
    reason: 'content attempts to hide behavior from the user',
  },
  {
    id: 'sys_prompt_override',
    re: /system\s+prompt\s+override/iu,
    reason: 'content references prompt override behavior',
  },
  {
    id: 'disregard_rules',
    re: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/iu,
    reason: 'content attempts to bypass runtime rules',
  },
  {
    id: 'bypass_restrictions',
    re: /act\s+as\s+(if|though)\s+you\s+(have\s+no|do(?:n'?t)?\s+have)\s+(restrictions|limits|rules)/iu,
    reason: 'content attempts to remove runtime restrictions',
  },
  {
    id: 'exfil_curl',
    re: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/iu,
    reason: 'content appears to exfiltrate secrets via curl',
  },
  {
    id: 'exfil_wget',
    re: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/iu,
    reason: 'content appears to exfiltrate secrets via wget',
  },
  {
    id: 'read_secrets',
    re: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/iu,
    reason: 'content appears to read secret material from disk',
  },
  {
    id: 'ssh_backdoor',
    re: /authorized_keys/iu,
    reason: 'content references SSH persistence',
  },
  {
    id: 'ssh_access',
    re: /(?:\$HOME|~)\/\.ssh/iu,
    reason: 'content references SSH key material',
  },
];

const CODE_CHANGE_PATTERNS: ThreatPattern[] = [
  {
    id: 'exfil_curl',
    re: /curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/iu,
    reason: 'file content appears to exfiltrate secrets via curl',
  },
  {
    id: 'exfil_wget',
    re: /wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/iu,
    reason: 'file content appears to exfiltrate secrets via wget',
  },
  {
    id: 'read_secrets',
    re: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/iu,
    reason: 'file content appears to read secret material from disk',
  },
  {
    id: 'ssh_backdoor',
    re: /authorized_keys/iu,
    reason: 'file content references SSH persistence',
  },
  {
    id: 'ssh_access',
    re: /(?:\$HOME|~)\/\.ssh/iu,
    reason: 'file content references SSH key material',
  },
];

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function patternsForProfile(profile: ContentScanProfile): ThreatPattern[] {
  return profile === 'memory' ? MEMORY_PATTERNS : CODE_CHANGE_PATTERNS;
}

export function scanContent(content: string, profile: ContentScanProfile): ContentScanResult {
  const hash = contentHash(content);

  for (const char of content) {
    if (INVISIBLE_CHARS.has(char)) {
      return {
        allowed: false,
        profile,
        contentHash: hash,
        severity: 'high',
        reason: `blocked invisible unicode U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        patternId: 'invisible_unicode',
      };
    }
  }

  for (const pattern of patternsForProfile(profile)) {
    if (pattern.re.test(content)) {
      return {
        allowed: false,
        profile,
        contentHash: hash,
        severity: 'high',
        reason: pattern.reason,
        patternId: pattern.id,
      };
    }
  }

  return {
    allowed: true,
    profile,
    contentHash: hash,
  };
}
