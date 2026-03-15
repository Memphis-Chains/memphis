import { AppError } from '../../core/errors.js';

/**
 * Maximum allowed length for a single manifest step.
 * Steps beyond this are likely obfuscated payloads.
 */
const MAX_STEP_LENGTH = 2048;

/**
 * Patterns that should NEVER appear in a managed app manifest step.
 * These cover destructive, privilege-escalation, and exfiltration scenarios.
 *
 * Note: Unlike gateway exec policy, manifest steps legitimately use shell
 * metacharacters (&&, $(), >, pipes). We block dangerous *commands*, not syntax.
 */
const BLOCKED_STEP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive filesystem operations
  { pattern: /rm\s+(-\w+\s+)*\//i, reason: 'rm targeting root paths' },
  { pattern: /rm\s+(-\w+\s+)*--no-preserve-root/i, reason: 'rm --no-preserve-root' },
  { pattern: /\bmkfs\b/i, reason: 'filesystem creation (mkfs)' },
  { pattern: /\bdd\b\s+.*of=/i, reason: 'dd write (of=)' },
  { pattern: /:\s*\(\s*\)\s*\{/, reason: 'fork bomb' },
  { pattern: />\s*\/dev\/(?!null)/i, reason: 'write to device file' },

  // Privilege escalation
  { pattern: /\bsudo\b/i, reason: 'privilege escalation (sudo)' },
  { pattern: /\bsu\s+-?\s*\w/i, reason: 'user switching (su)' },
  { pattern: /\bchown\s+(-\w+\s+)*root/i, reason: 'chown to root' },
  { pattern: /\bchmod\s+(-\w+\s+)*[0-7]*[2367][67]\s+\//i, reason: 'chmod world/group-writable on root paths' },

  // Network exfiltration / reverse shells
  { pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/i, reason: 'pipe from curl to shell' },
  { pattern: /\bwget\b.*\|\s*(bash|sh|zsh)/i, reason: 'pipe from wget to shell' },
  { pattern: /\bnc\b.*-[le]/i, reason: 'netcat listener' },
  { pattern: /\bncat\b/i, reason: 'ncat' },
  { pattern: /\bsocat\b/i, reason: 'socat' },
  { pattern: /\/dev\/tcp\//i, reason: '/dev/tcp reverse shell' },
  { pattern: /\bmkfifo\b/i, reason: 'mkfifo (named pipe for shell redirect)' },

  // Inline script execution (bypass intent of the step)
  { pattern: /\bpython[23]?\s+-c\b/i, reason: 'inline python execution' },
  { pattern: /\bperl\s+-e\b/i, reason: 'inline perl execution' },
  { pattern: /\bruby\s+-e\b/i, reason: 'inline ruby execution' },
  { pattern: /\beval\s/i, reason: 'shell eval' },

  // System-level damage
  { pattern: /\bshutdown\b/i, reason: 'system shutdown' },
  { pattern: /\breboot\b/i, reason: 'system reboot' },
  { pattern: /\bkillall\b/i, reason: 'mass process kill' },
  { pattern: /\bsystemctl\s+(stop|disable|mask)\s+(?!.*--user)/i, reason: 'system-wide service manipulation (use --user)' },
  { pattern: /\biptables\b/i, reason: 'firewall manipulation' },

  // Sensitive file access
  { pattern: /\/etc\/shadow/i, reason: '/etc/shadow access' },
  { pattern: /\/etc\/sudoers/i, reason: '/etc/sudoers access' },

  // Encoded payload obfuscation
  { pattern: /\bbase64\s+(-d|--decode)\b.*\|\s*(bash|sh|zsh)/i, reason: 'base64-decoded shell execution' },
  { pattern: /\bxxd\b.*\|\s*(bash|sh|zsh)/i, reason: 'hex-decoded shell execution' },
];

export type StepValidationResult = {
  ok: boolean;
  step: string;
  reason?: string;
};

/**
 * Validate a single manifest step against the security blocklist.
 */
export function validateManifestStep(step: string): StepValidationResult {
  if (step.length > MAX_STEP_LENGTH) {
    return { ok: false, step, reason: `step exceeds maximum length (${MAX_STEP_LENGTH} chars)` };
  }

  for (const { pattern, reason } of BLOCKED_STEP_PATTERNS) {
    if (pattern.test(step)) {
      return { ok: false, step, reason: `blocked pattern: ${reason}` };
    }
  }

  return { ok: true, step };
}

/**
 * Validate all steps in a manifest action. Throws on first violation.
 */
export function enforceManifestSteps(steps: string[], context: { manifestId: string; action: string }): void {
  for (const step of steps) {
    const result = validateManifestStep(step);
    if (!result.ok) {
      throw new AppError(
        'VALIDATION_ERROR',
        `manifest step blocked: ${result.reason} — in action '${context.action}' of '${context.manifestId}'`,
        403,
        { step, ...context },
      );
    }
  }
}
