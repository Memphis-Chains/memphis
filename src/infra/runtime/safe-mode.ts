import { spawnSync } from 'node:child_process';

export interface SafeModeNetworkResult {
  attempted: boolean;
  enforced: boolean;
  reason?: string;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (typeof value !== 'string') return fallback;
  return value.trim().toLowerCase() === 'true';
}

function currentUidString(): string {
  if (typeof process.getuid === 'function') {
    return String(process.getuid());
  }
  return '0';
}

export function enforceSafeModeNoEgress(
  rawEnv: NodeJS.ProcessEnv = process.env,
): SafeModeNetworkResult {
  const enabled = parseBool(rawEnv.MEMPHIS_SAFE_MODE, false);
  if (!enabled) {
    return { attempted: false, enforced: false, reason: 'safe mode disabled' };
  }

  // Capability probe + scoped rule for current UID only.
  // This keeps safe-mode intent explicit without mutating global host networking outside this UID.
  const uid = currentUidString();
  const addRule = [
    '-w',
    '-A',
    'OUTPUT',
    '-m',
    'owner',
    '--uid-owner',
    uid,
    '-m',
    'comment',
    '--comment',
    'memphis-safe-mode',
    '-j',
    'REJECT',
  ];

  try {
    const probe = spawnSync('iptables', ['-w', '-L', 'OUTPUT'], {
      stdio: 'ignore',
      timeout: 1500,
    });
    if (probe.status !== 0) {
      return {
        attempted: true,
        enforced: false,
        reason: `iptables probe failed with status ${String(probe.status)}`,
      };
    }

    const apply = spawnSync('iptables', addRule, {
      stdio: 'ignore',
      timeout: 2000,
    });
    if (apply.status !== 0) {
      return {
        attempted: true,
        enforced: false,
        reason: `iptables apply failed with status ${String(apply.status)}`,
      };
    }
    return { attempted: true, enforced: true };
  } catch (error) {
    return {
      attempted: true,
      enforced: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function safeModeEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_SAFE_MODE, false);
}
