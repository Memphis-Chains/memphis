export type OllamaReadiness = {
  reachable: boolean;
  model: string;
  modelPresent: boolean;
  canGenerate: boolean;
  reason: 'ready' | 'unreachable' | 'invalid-response' | 'model-missing' | 'completion-unverified';
};

function canonicalModel(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

/** Metadata-only probe. Never loads, downloads or generates with a model. */
export async function probeOllamaReadiness(url: string, model: string): Promise<OllamaReadiness> {
  const result: OllamaReadiness = {
    reachable: false,
    model,
    modelPresent: false,
    canGenerate: false,
    reason: 'unreachable',
  };
  const base = url.replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/api/tags`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(400),
    });
    if (!response.ok) return result;
    const tags: unknown = await response.json();
    if (!tags || typeof tags !== 'object' || !('models' in tags) || !Array.isArray(tags.models)) {
      return { ...result, reason: 'invalid-response' };
    }
    result.reachable = true;
    result.modelPresent = tags.models.some(
      (entry: unknown) =>
        !!entry &&
        typeof entry === 'object' &&
        'name' in entry &&
        typeof entry.name === 'string' &&
        canonicalModel(entry.name) === canonicalModel(model),
    );
    if (!result.modelPresent) return { ...result, reason: 'model-missing' };
    result.reason = 'completion-unverified';
    const detailsResponse = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      redirect: 'error',
      signal: AbortSignal.timeout(400),
    });
    if (!detailsResponse.ok) return result;
    const details: unknown = await detailsResponse.json();
    result.canGenerate =
      !!details &&
      typeof details === 'object' &&
      'capabilities' in details &&
      Array.isArray(details.capabilities) &&
      details.capabilities.includes('completion');
    return { ...result, reason: result.canGenerate ? 'ready' : 'completion-unverified' };
  } catch {
    return result;
  }
}
