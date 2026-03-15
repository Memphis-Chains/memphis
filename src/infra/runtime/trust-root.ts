export interface TrustRootManifest {
  version: number;
  rootIds: string[];
  revokedKeys?: string[];
}

export interface TrustRootTransition {
  oldRootId: string;
  newRootId: string;
  reason: string;
  timestamp: string;
  signature: string;
}

export interface TrustRootValidationResult {
  ok: boolean;
  error?: string;
}

function hasDistinctEntries(values: string[]): boolean {
  return new Set(values).size === values.length;
}

export function validateTrustRootTransition(
  current: TrustRootManifest,
  next: TrustRootManifest,
  transition: TrustRootTransition,
): TrustRootValidationResult {
  if (!Number.isInteger(next.version) || next.version <= current.version) {
    return {
      ok: false,
      error: `trust root downgrade rejected: next version (${next.version}) must be > current (${current.version})`,
    };
  }

  if (
    !Array.isArray(next.rootIds) ||
    next.rootIds.length === 0 ||
    !hasDistinctEntries(next.rootIds)
  ) {
    return { ok: false, error: 'invalid next trust root ids' };
  }

  if (!current.rootIds.includes(transition.oldRootId)) {
    return { ok: false, error: 'transition oldRootId not found in current trust root set' };
  }

  if (!next.rootIds.includes(transition.newRootId)) {
    return { ok: false, error: 'transition newRootId not found in next trust root set' };
  }

  if (!transition.reason.trim()) {
    return { ok: false, error: 'transition reason is required' };
  }

  if (!transition.signature.trim()) {
    return { ok: false, error: 'transition signature is required' };
  }

  if (next.revokedKeys && !hasDistinctEntries(next.revokedKeys)) {
    return { ok: false, error: 'next revokedKeys must not contain duplicates' };
  }

  return { ok: true };
}
